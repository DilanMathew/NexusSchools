export interface Slot {
  id?: string;
  dayOfWeek: number;
  periodId: string;
  staffId: string | null;
  sectionId: string | null;
  roomId: string | null;
  /** students on explicit-enrolment offerings, for elective clash detection (optional) */
  offeringId?: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}
export interface Conflict { kind: 'faculty' | 'room' | 'section'; withEntryId?: string; message: string }

const overlaps = (a: Slot, b: Slot) =>
  (a.effectiveFrom ?? '0000-01-01') <= (b.effectiveTo ?? '9999-12-31') && (b.effectiveFrom ?? '0000-01-01') <= (a.effectiveTo ?? '9999-12-31');

/** Pure conflict detection: faculty double-booking, room double-booking and class clashes in the same slot. */
export function findConflicts(candidate: Slot, existing: Slot[]): Conflict[] {
  const out: Conflict[] = [];
  for (const e of existing) {
    if (e.id && e.id === candidate.id) continue;
    if (e.dayOfWeek !== candidate.dayOfWeek || e.periodId !== candidate.periodId || !overlaps(candidate, e)) continue;
    if (candidate.offeringId && e.offeringId === candidate.offeringId) { out.push({ kind: 'section', withEntryId: e.id, message: 'This class is already scheduled in this slot' }); continue; }
    if (candidate.staffId && e.staffId === candidate.staffId) out.push({ kind: 'faculty', withEntryId: e.id, message: 'Faculty member is already teaching in this slot' });
    if (candidate.roomId && e.roomId === candidate.roomId) out.push({ kind: 'room', withEntryId: e.id, message: 'Room is already booked in this slot' });
    if (candidate.sectionId && e.sectionId === candidate.sectionId) out.push({ kind: 'section', withEntryId: e.id, message: 'Section already has a class in this slot' });
  }
  return out;
}
