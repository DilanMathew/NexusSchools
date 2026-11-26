/**
 * Attendance calculation engine — pure functions, no I/O. All percentage logic lives here so it is
 * unit-testable and every report/dashboard computes identically.
 *
 *   percentage = Σ weight(record) / count(records whose weight is not null) × 100
 *
 * weight() is derived from the institution's policy: 1 = attended, 0 = missed, fractional for
 * late/half-day, null = excluded from the denominator (e.g. approved leave when policy says "exclude").
 */
import type { AttendanceStatus } from '../../db/schema/attendance.js';

export interface PolicyInput {
  id?: string;
  version?: number;
  calculationUnit: 'session' | 'day' | string;
  lateWeight: number | string | null;
  halfDayWeight: number | string | null;
  onDutyCountsAsPresent: boolean;
  approvedLeaveHandling: 'exclude' | 'present' | 'absent' | string;
  medicalLeaveHandling: 'exclude' | 'present' | 'absent' | string;
  excusedHandling: 'exclude' | 'present' | 'absent' | string;
  excludeHolidays: boolean;
  separateLabAndTheory: boolean;
  eligibilityThreshold: number | string;
  warningThreshold: number | string;
}

export interface RecordInput {
  status: AttendanceStatus;
  date: string;
  /** subject kind etc., used for separate lab/theory buckets */
  category?: string;
  sessionCancelled?: boolean;
}

const num = (v: number | string | null | undefined, d: number) => (v === null || v === undefined || v === '' ? d : Number(v));
const handling = (h: string): number | null => (h === 'present' ? 1 : h === 'absent' ? 0 : null);

export function statusWeight(status: AttendanceStatus, p: PolicyInput): number | null {
  switch (status) {
    case 'present': return 1;
    case 'absent': return 0;
    case 'late': return num(p.lateWeight, 1);
    case 'half_day': return num(p.halfDayWeight, 0.5);
    case 'on_duty': return p.onDutyCountsAsPresent ? 1 : null;
    case 'on_leave': return handling(p.approvedLeaveHandling);
    case 'medical_leave': return handling(p.medicalLeaveHandling);
    case 'excused': return handling(p.excusedHandling);
    case 'holiday': return p.excludeHolidays ? null : 1;
    case 'not_applicable': return null;
    case 'pending_verification': return null; // never counted until verified
    default: return null;
  }
}

export interface Summary {
  conducted: number; // sessions/days counted in the denominator
  attended: number; // weighted
  percentage: number | null;
  counts: Partial<Record<AttendanceStatus, number>>;
  excluded: number;
}

/** In 'day' mode multiple sessions on the same date collapse to one day, using the mean weight of counted sessions. */
export function summarize(records: RecordInput[], p: PolicyInput): Summary {
  const counts: Partial<Record<AttendanceStatus, number>> = {};
  let excluded = 0;
  const live = records.filter((r) => !r.sessionCancelled);
  for (const r of live) counts[r.status] = (counts[r.status] ?? 0) + 1;

  let conducted = 0;
  let attended = 0;
  if (p.calculationUnit === 'day') {
    const byDay = new Map<string, number[]>();
    for (const r of live) {
      const w = statusWeight(r.status, p);
      if (w === null) { excluded++; continue; }
      const arr = byDay.get(r.date) ?? [];
      arr.push(w);
      byDay.set(r.date, arr);
    }
    for (const ws of byDay.values()) {
      conducted += 1;
      attended += ws.reduce((a, b) => a + b, 0) / ws.length;
    }
  } else {
    for (const r of live) {
      const w = statusWeight(r.status, p);
      if (w === null) { excluded++; continue; }
      conducted += 1;
      attended += w;
    }
  }
  return { conducted, attended: round(attended, 2), percentage: conducted ? round((attended / conducted) * 100, 2) : null, counts, excluded };
}

export type EligibilityBand = 'eligible' | 'warning' | 'shortage' | 'no_data';

export function band(pct: number | null, p: PolicyInput): EligibilityBand {
  if (pct === null) return 'no_data';
  if (pct < num(p.eligibilityThreshold, 75)) return 'shortage';
  if (pct < num(p.warningThreshold, 85)) return 'warning';
  return 'eligible';
}

/**
 * Smallest n such that (attended + n) / (conducted + n) ≥ threshold — i.e. consecutive sessions the
 * student must attend to reach the threshold. 0 if already there; null if unreachable (threshold 100 with any miss).
 */
export function sessionsNeeded(attended: number, conducted: number, thresholdPct: number): number | null {
  const t = thresholdPct / 100;
  if (conducted === 0 || attended / conducted >= t - 1e-9) return 0;
  if (t >= 1) return null;
  return Math.ceil((t * conducted - attended) / (1 - t) - 1e-9);
}

/** Largest m such that attended / (conducted + m) ≥ threshold — sessions that can be missed and still stay eligible. */
export function maxMissable(attended: number, conducted: number, thresholdPct: number): number {
  const t = thresholdPct / 100;
  if (t <= 0) return Number.POSITIVE_INFINITY;
  if (conducted === 0) return 0;
  return Math.max(0, Math.floor(attended / t - conducted + 1e-9));
}

export function eligibilityDetail(s: Summary, p: PolicyInput) {
  const threshold = num(p.eligibilityThreshold, 75);
  return {
    ...s,
    band: band(s.percentage, p),
    requiredPercentage: threshold,
    sessionsNeeded: sessionsNeeded(s.attended, s.conducted, threshold),
    maxMissable: maxMissable(s.attended, s.conducted, threshold),
  };
}

/** Separate buckets per category (e.g. theory vs lab) when the policy asks for it. */
export function summarizeByCategory(records: RecordInput[], p: PolicyInput) {
  if (!p.separateLabAndTheory) return { all: eligibilityDetail(summarize(records, p), p) };
  const cats = new Map<string, RecordInput[]>();
  for (const r of records) {
    const c = r.category === 'lab' || r.category === 'practical' ? 'lab' : 'theory';
    cats.set(c, [...(cats.get(c) ?? []), r]);
  }
  const out: Record<string, ReturnType<typeof eligibilityDetail>> = { all: eligibilityDetail(summarize(records, p), p) };
  for (const [k, v] of cats) out[k] = eligibilityDetail(summarize(v, p), p);
  return out;
}

/** Longest run of consecutive (by date order) days on which the student was absent from every counted session. */
export function consecutiveAbsentDays(records: RecordInput[]): { current: number; longest: number } {
  const byDay = new Map<string, AttendanceStatus[]>();
  for (const r of records) if (!r.sessionCancelled) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r.status]);
  const days = [...byDay.keys()].sort();
  let run = 0; let longest = 0;
  for (const d of days) {
    const sts = byDay.get(d)!;
    const allAbsent = sts.every((s) => s === 'absent');
    const counted = sts.some((s) => s !== 'holiday' && s !== 'not_applicable');
    if (!counted) continue;
    run = allAbsent ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return { current: run, longest };
}

export function policySnapshot(p: PolicyInput) {
  return {
    id: p.id, version: p.version, calculationUnit: p.calculationUnit, lateWeight: num(p.lateWeight, 1), halfDayWeight: num(p.halfDayWeight, 0.5),
    onDutyCountsAsPresent: p.onDutyCountsAsPresent, approvedLeaveHandling: p.approvedLeaveHandling, medicalLeaveHandling: p.medicalLeaveHandling,
    excusedHandling: p.excusedHandling, excludeHolidays: p.excludeHolidays, separateLabAndTheory: p.separateLabAndTheory,
    eligibilityThreshold: num(p.eligibilityThreshold, 75), warningThreshold: num(p.warningThreshold, 85),
  };
}

function round(v: number, d: number) { const f = 10 ** d; return Math.round(v * f) / f; }

/** Percentage from pre-aggregated status counts (used by dashboards over large populations). */
export function pctFromCounts(counts: Partial<Record<AttendanceStatus, number>>, p: PolicyInput) {
  let num = 0; let den = 0;
  for (const [status, n] of Object.entries(counts) as [AttendanceStatus, number][]) {
    const w = statusWeight(status, p);
    if (w === null) continue;
    num += w * n; den += n;
  }
  return { attended: round(num, 2), conducted: den, percentage: den ? round((num / den) * 100, 2) : null };
}
