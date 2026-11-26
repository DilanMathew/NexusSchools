import { Router, type Response } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { attendanceRecords, attendanceSessions, students, studentEnrolments, sections, classLevels, departments, courseOfferings, subjects, academicYears, periods } from '../../db/schema/index.js';
import { parse, isoDate } from '../../lib/http.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { auditReq } from '../../lib/audit.js';
import { addDays, eachDate, todayIn } from '../../lib/dates.js';
import { attendanceScope } from '../attendance/scope.js';
import { asPolicyInput, getDefaultPolicy, getRoster } from '../attendance/service.js';
import { band, consecutiveAbsentDays, maxMissable, pctFromCounts, policySnapshot, sessionsNeeded, summarize } from '../attendance/engine.js';
import { countedSessions, groupedStatusCounts, sessionScopeFilter } from '../analytics/queries.js';
import { submissionCompliance } from '../analytics/routes.js';
import { toCsv } from './csv.js';
import ExcelJS from 'exceljs';
const toTable = (headers: string[], rows: Table['rows'], preamble?: string[]): Table => ({ headers, rows, preamble });

export const reportsRouter = Router();
reportsRouter.use(requirePermission('reports.read'));

const fmt = z.enum(['json', 'csv', 'xlsx']).default('json');
interface Table { headers: string[]; rows: (string | number | null | undefined)[][]; preamble?: string[] }

/** One table definition, three formats: JSON for the UI, CSV, and a real Excel workbook. */
async function send(res: Response, format: 'json' | 'csv' | 'xlsx', name: string, json: unknown, table: () => Table) {
  if (format === 'csv') {
    const t = table();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send('\uFEFF' + toCsv(t.headers, t.rows, t.preamble));
  }
  if (format === 'xlsx') {
    const t = table();
    const wb = new ExcelJS.Workbook();
    wb.creator = 'NEXUS AttendIQ';
    const ws = wb.addWorksheet('Report');
    for (const line of t.preamble ?? []) ws.addRow([line]).font = { italic: true, color: { argb: 'FF64748B' } };
    if (t.preamble?.length) ws.addRow([]);
    const head = ws.addRow(t.headers);
    head.font = { bold: true };
    head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } }; });
    // Values are written as plain cells; a string that looks like a formula stays text.
    for (const r of t.rows) ws.addRow(r.map((v) => (v === null || v === undefined ? '' : v)));
    ws.columns.forEach((col, i) => { col.width = Math.min(40, Math.max(8, (t.headers[i]?.length ?? 8), ...t.rows.slice(0, 200).map((r) => String(r[i] ?? '').length)) + 2); });
    ws.views = [{ state: 'frozen', ySplit: head.number }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    return res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  }
  res.json(json);
}

async function defaultFrom(inst: string) {
  const [y] = await db.select().from(academicYears).where(and(eq(academicYears.institutionId, inst), eq(academicYears.isCurrent, true)));
  return y?.startDate;
}

const studentReportQuery = z.object({
  from: isoDate.optional(), to: isoDate.optional(), sectionId: z.string().uuid().optional(), courseOfferingId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(),
  band: z.enum(['eligible', 'warning', 'shortage']).optional(), sort: z.enum(['percentage', 'late', 'absent', 'name']).default('name'), format: fmt,
});

/**
 * Per-student attendance report. Covers: class report (sectionId), subject report (courseOfferingId),
 * department report (departmentId), shortage/eligibility report (band), late-arrival report (sort=late).
 */
reportsRouter.get('/students', async (req, res) => {
  const ctx = req.ctx!;
  const q = parse(studentReportQuery, req.query);
  const to = q.to ?? todayIn(ctx.timezone);
  const from = q.from ?? (await defaultFrom(ctx.institutionId)) ?? addDays(to, -90);
  const policy = await getDefaultPolicy(ctx.institutionId);
  const p = asPolicyInput(policy);
  const pp = q.courseOfferingId ? { ...p, calculationUnit: 'session' } : p;
  const scope = await attendanceScope(ctx);
  const filter = and(countedSessions(ctx.institutionId, from, to), sessionScopeFilter(scope),
    q.sectionId ? eq(attendanceSessions.sectionId, q.sectionId) : undefined,
    q.courseOfferingId ? eq(attendanceSessions.courseOfferingId, q.courseOfferingId) : undefined,
    q.departmentId ? inArray(attendanceSessions.sectionId, db.select({ id: sections.id }).from(sections).where(eq(sections.departmentId, q.departmentId))) : undefined);

  interface Row { studentId: string; attended: number; conducted: number; percentage: number | null; absent: number; late: number; leave: number }
  let rowsOut: Row[] = [];
  if (pp.calculationUnit === 'day') {
    // Day mode needs per-record dates; summarise in memory.
    const recs = await db.select({ studentId: attendanceRecords.studentId, status: attendanceRecords.status, date: attendanceSessions.sessionDate }).from(attendanceRecords).innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId)).where(filter);
    const by = new Map<string, { status: typeof recs[number]['status']; date: string }[]>();
    for (const r of recs) by.set(r.studentId, [...(by.get(r.studentId) ?? []), r]);
    rowsOut = [...by.entries()].map(([studentId, rs]) => { const s = summarize(rs, pp); return { studentId, attended: s.attended, conducted: s.conducted, percentage: s.percentage, absent: s.counts.absent ?? 0, late: s.counts.late ?? 0, leave: (s.counts.on_leave ?? 0) + (s.counts.medical_leave ?? 0) }; });
  } else {
    const counts = await groupedStatusCounts(sql`${attendanceRecords.studentId}`, filter);
    rowsOut = [...counts.entries()].map(([studentId, c]) => ({ studentId, ...pctFromCounts(c, pp), absent: c.absent ?? 0, late: c.late ?? 0, leave: (c.on_leave ?? 0) + (c.medical_leave ?? 0) }));
  }
  const th = Number(policy.eligibilityThreshold);
  let rows = rowsOut.map((r) => ({ ...r, band: band(r.percentage, p), sessionsNeeded: sessionsNeeded(r.attended, r.conducted, th), maxMissable: maxMissable(r.attended, r.conducted, th) }));
  if (q.band) rows = rows.filter((r) => r.band === q.band);
  const meta = rows.length ? await db.select({ id: students.id, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, admissionNumber: students.admissionNumber, roll: studentEnrolments.rollNumber, section: sections.name, level: classLevels.name })
    .from(students).leftJoin(studentEnrolments, and(eq(studentEnrolments.studentId, students.id), eq(studentEnrolments.isActive, true))).leftJoin(sections, eq(sections.id, studentEnrolments.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId))
    .where(inArray(students.id, rows.map((r) => r.studentId as string))) : [];
  const full = rows.map((r) => { const m = meta.find((x) => x.id === r.studentId); return { ...r, name: m?.name ?? '', admissionNumber: m?.admissionNumber ?? '', rollNumber: m?.roll ?? '', classLabel: m ? `${m.level ?? ''} ${m.section ?? ''}`.trim() : '' }; });
  const sorters: Record<string, (a: typeof full[number], b: typeof full[number]) => number> = {
    name: (a, b) => a.classLabel.localeCompare(b.classLabel) || String(a.rollNumber).localeCompare(String(b.rollNumber), undefined, { numeric: true }) || a.name.localeCompare(b.name),
    percentage: (a, b) => ((a.percentage as number) ?? 0) - ((b.percentage as number) ?? 0),
    late: (a, b) => (b.late as number) - (a.late as number), absent: (a, b) => (b.absent as number) - (a.absent as number),
  };
  full.sort(sorters[q.sort]);
  await auditReq(db, req, { action: 'report.generated', entityType: 'report', entityId: 'students', metadata: { ...q, rows: full.length } });
  const snap = policySnapshot(p);
  await send(res, q.format, `attendance-report-${from}-to-${to}`, { data: full, meta: { from, to, policy: snap, generatedAt: new Date().toISOString() } }, () => toTable(
    ['Admission No', 'Roll', 'Name', 'Class', 'Attended', 'Counted', 'Percentage', 'Absent', 'Late', 'Leave', 'Band', 'Sessions needed', 'Can miss'],
    full.map((r) => [r.admissionNumber, r.rollNumber, r.name, r.classLabel, r.attended as number, r.conducted as number, r.percentage as number, r.absent as number, r.late as number, r.leave as number, r.band, r.sessionsNeeded, r.maxMissable]),
    [`NEXUS AttendIQ attendance report ${from} to ${to}`, `Policy v${snap.version}: unit=${snap.calculationUnit}, late=${snap.lateWeight}, eligibility=${snap.eligibilityThreshold}%`, 'Indicative figures; official eligibility is decided by the institution.'],
  ));
});

/** Monthly register: one row per student, one column per date, with the day's mark. */
reportsRouter.get('/monthly-register', async (req, res) => {
  const ctx = req.ctx!;
  const q = parse(z.object({ sectionId: z.string().uuid(), month: z.string().regex(/^\d{4}-\d{2}$/), format: fmt }), req.query);
  const scope = await attendanceScope(ctx);
  if (!scope.all && !scope.rosterSectionIds.includes(q.sectionId)) throw forbidden('This class is outside your access');
  const from = `${q.month}-01`;
  const to = addDays(addDays(from, 32).slice(0, 8) + '01', -1);
  const [sec] = await db.select({ name: sections.name, level: classLevels.name }).from(sections).innerJoin(classLevels, eq(classLevels.id, sections.classLevelId)).where(and(eq(sections.id, q.sectionId), eq(sections.institutionId, ctx.institutionId)));
  if (!sec) throw badRequest('Unknown section');
  const roster = await getRoster(db, { institutionId: ctx.institutionId, sectionId: q.sectionId, courseOfferingId: null });
  const recs = await db.select({ studentId: attendanceRecords.studentId, status: attendanceRecords.status, date: attendanceSessions.sessionDate })
    .from(attendanceRecords).innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
    .where(and(countedSessions(ctx.institutionId, from, to), eq(attendanceSessions.sectionId, q.sectionId)));
  const p = asPolicyInput(await getDefaultPolicy(ctx.institutionId));
  const days = eachDate(from, to);
  const code: Record<string, string> = { present: 'P', absent: 'A', late: 'L', half_day: 'H', on_leave: 'LV', medical_leave: 'ML', on_duty: 'OD', excused: 'E', holiday: 'HO', not_applicable: '-', pending_verification: '?' };
  const rows = roster.map((s) => {
    const mine = recs.filter((r) => r.studentId === s.id);
    const marks = days.map((d) => {
      const day = mine.filter((r) => r.date === d);
      if (!day.length) return '';
      if (day.every((r) => r.status === 'absent')) return 'A';
      const st = day.find((r) => r.status !== 'present')?.status ?? 'present';
      return day.length > 1 && day.some((r) => r.status === 'absent') ? 'P/A' : code[st];
    });
    const sum = summarize(mine, p);
    return { studentId: s.id, name: `${s.firstName} ${s.lastName}`.trim(), admissionNumber: s.admissionNumber, rollNumber: s.rollNumber, marks, percentage: sum.percentage, conducted: sum.conducted };
  });
  await send(res, q.format, `monthly-register-${sec.level}-${sec.name}-${q.month}`.replace(/\s+/g, '_'), { data: { section: `${sec.level} ${sec.name}`, month: q.month, days, rows, legend: code } }, () => toTable(
    ['Roll', 'Admission No', 'Name', ...days.map((d) => d.slice(8)), '%'], rows.map((r) => [r.rollNumber, r.admissionNumber, r.name, ...r.marks, r.percentage]), [`Monthly register: ${sec.level} ${sec.name}, ${q.month}`]));
});

/** Daily register for a section: every session that day × students. */
reportsRouter.get('/daily-register', async (req, res) => {
  const ctx = req.ctx!;
  const q = parse(z.object({ sectionId: z.string().uuid(), date: isoDate, format: fmt }), req.query);
  const scope = await attendanceScope(ctx);
  if (!scope.all && !scope.rosterSectionIds.includes(q.sectionId)) throw forbidden('This class is outside your access');
  const sess = await db.select({ id: attendanceSessions.id, kind: attendanceSessions.kind, status: attendanceSessions.status, subject: subjects.name, period: periods.name, ord: periods.ordinal })
    .from(attendanceSessions).leftJoin(courseOfferings, eq(courseOfferings.id, attendanceSessions.courseOfferingId)).leftJoin(subjects, eq(subjects.id, courseOfferings.subjectId)).leftJoin(periods, eq(periods.id, attendanceSessions.periodId))
    .where(and(eq(attendanceSessions.institutionId, ctx.institutionId), eq(attendanceSessions.sectionId, q.sectionId), eq(attendanceSessions.sessionDate, q.date), sql`${attendanceSessions.status} <> 'cancelled'`)).orderBy(asc(periods.ordinal));
  const roster = await getRoster(db, { institutionId: ctx.institutionId, sectionId: q.sectionId, courseOfferingId: null });
  const recs = sess.length ? await db.select().from(attendanceRecords).where(inArray(attendanceRecords.sessionId, sess.map((s) => s.id))) : [];
  const cols = sess.map((s) => ({ id: s.id, label: s.kind === 'daily' ? 'Daily' : `${s.period ?? ''} ${s.subject ?? ''}`.trim(), status: s.status }));
  const rows = roster.map((st) => ({ name: `${st.firstName} ${st.lastName}`.trim(), rollNumber: st.rollNumber, admissionNumber: st.admissionNumber, marks: cols.map((c) => recs.find((r) => r.sessionId === c.id && r.studentId === st.id)?.status ?? null) }));
  await send(res, q.format, `daily-register-${q.date}`, { data: { date: q.date, sessions: cols, rows } }, () => toTable(['Roll', 'Admission No', 'Name', ...cols.map((c) => c.label)], rows.map((r) => [r.rollNumber, r.admissionNumber, r.name, ...r.marks])));
});

/** Students absent for N or more consecutive counted days (up to `to`). */
reportsRouter.get('/consecutive-absences', async (req, res) => {
  const ctx = req.ctx!;
  const q = parse(z.object({ minDays: z.coerce.number().int().min(2).max(60).default(3), to: isoDate.optional(), lookbackDays: z.coerce.number().int().min(7).max(120).default(30), format: fmt }), req.query);
  const to = q.to ?? todayIn(ctx.timezone);
  const from = addDays(to, -q.lookbackDays);
  const scope = await attendanceScope(ctx);
  const recs = await db.select({ studentId: attendanceRecords.studentId, status: attendanceRecords.status, date: attendanceSessions.sessionDate }).from(attendanceRecords).innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
    .where(and(countedSessions(ctx.institutionId, from, to), sessionScopeFilter(scope)));
  const by = new Map<string, typeof recs>();
  for (const r of recs) by.set(r.studentId, [...(by.get(r.studentId) ?? []), r]);
  const hits = [...by.entries()].map(([id, rs]) => ({ studentId: id, ...consecutiveAbsentDays(rs), lastAbsent: rs.filter((r) => r.status === 'absent').map((r) => r.date).sort().at(-1) })).filter((h) => h.current >= q.minDays).sort((a, b) => b.current - a.current);
  const meta = hits.length ? await db.select({ id: students.id, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, admissionNumber: students.admissionNumber, section: sections.name, level: classLevels.name, dept: departments.name })
    .from(students).leftJoin(studentEnrolments, and(eq(studentEnrolments.studentId, students.id), eq(studentEnrolments.isActive, true))).leftJoin(sections, eq(sections.id, studentEnrolments.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId)).leftJoin(departments, eq(departments.id, sections.departmentId))
    .where(inArray(students.id, hits.map((h) => h.studentId))) : [];
  const rows = hits.map((h) => { const m = meta.find((x) => x.id === h.studentId); return { ...h, name: m?.name, admissionNumber: m?.admissionNumber, classLabel: `${m?.level ?? ''} ${m?.section ?? ''}`.trim() }; });
  await send(res, q.format, `consecutive-absences-${to}`, { data: rows, meta: { from, to, minDays: q.minDays } }, () => toTable(['Admission No', 'Name', 'Class', 'Current run (days)', 'Longest run', 'Last absent'], rows.map((r) => [r.admissionNumber, r.name, r.classLabel, r.current, r.longest, r.lastAbsent])));
});

reportsRouter.get('/compliance', async (req, res) => {
  const ctx = req.ctx!;
  const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional(), format: fmt }), req.query);
  const to = q.to ?? todayIn(ctx.timezone);
  const data = await submissionCompliance(ctx.institutionId, q.from ?? addDays(to, -6), to);
  await send(res, q.format, `submission-compliance-${data.from}-${data.to}`, { data }, () => toTable(['Faculty', 'Expected', 'Submitted', 'Pending', 'Cancelled', 'Compliance %'], data.staff.map((s) => [s.staffName, s.expected, s.submitted, s.pending, s.cancelled, s.complianceRate])));
});
void departments;
