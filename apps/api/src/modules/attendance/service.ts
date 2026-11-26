import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import {
  attendancePolicies, attendanceSessions, attendanceRecords, courseOfferings, sections, studentEnrolments, subjectEnrolments,
  students, periods, studentGuardians, guardians, subjects, institutionSettings, type AttendanceStatus,
} from '../../db/schema/index.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import type { TenantContext } from '../../types.js';
import { notify } from '../notifications/service.js';
import type { PolicyInput } from './engine.js';

export type Policy = typeof attendancePolicies.$inferSelect;

export async function getDefaultPolicy(institutionId: string, conn: DbOrTx = db): Promise<Policy> {
  const [p] = await conn.select().from(attendancePolicies).where(and(eq(attendancePolicies.institutionId, institutionId), eq(attendancePolicies.isDefault, true)));
  if (!p) throw new AppError(500, 'NO_POLICY', 'Institution has no default attendance policy');
  return p;
}
export const asPolicyInput = (p: Policy): PolicyInput => p as unknown as PolicyInput;

export type Session = typeof attendanceSessions.$inferSelect;

export async function getSession(institutionId: string, id: string, conn: DbOrTx = db) {
  const [s] = await conn.select().from(attendanceSessions).where(and(eq(attendanceSessions.id, id), eq(attendanceSessions.institutionId, institutionId)));
  if (!s) throw notFound('Attendance session');
  return s;
}

/** Students expected in a session. Offerings use section roster (auto) or explicit subject enrolments (electives). */
export async function getRoster(conn: DbOrTx, s: { institutionId: string; courseOfferingId: string | null; sectionId: string | null }) {
  const cols = { id: students.id, firstName: students.firstName, lastName: students.lastName, admissionNumber: students.admissionNumber, photoUrl: students.photoUrl, userId: students.userId };
  const active = and(eq(students.status, 'active'), sql`${students.deletedAt} is null`, eq(students.institutionId, s.institutionId));
  if (s.courseOfferingId) {
    const [o] = await conn.select().from(courseOfferings).where(eq(courseOfferings.id, s.courseOfferingId));
    if (!o) return [];
    if (o.autoEnrolSection && o.sectionId) {
      return conn.select({ ...cols, rollNumber: studentEnrolments.rollNumber }).from(studentEnrolments).innerJoin(students, eq(students.id, studentEnrolments.studentId))
        .where(and(eq(studentEnrolments.sectionId, o.sectionId), eq(studentEnrolments.isActive, true), active)).orderBy(sql`nullif(regexp_replace(${studentEnrolments.rollNumber}, '\\D', '', 'g'), '')::int nulls last`, students.firstName);
    }
    return conn.select({ ...cols, rollNumber: sql<string | null>`null` }).from(subjectEnrolments).innerJoin(students, eq(students.id, subjectEnrolments.studentId))
      .where(and(eq(subjectEnrolments.courseOfferingId, o.id), active)).orderBy(students.firstName, students.lastName);
  }
  if (s.sectionId) {
    return conn.select({ ...cols, rollNumber: studentEnrolments.rollNumber }).from(studentEnrolments).innerJoin(students, eq(students.id, studentEnrolments.studentId))
      .where(and(eq(studentEnrolments.sectionId, s.sectionId), eq(studentEnrolments.isActive, true), active)).orderBy(sql`nullif(regexp_replace(${studentEnrolments.rollNumber}, '\\D', '', 'g'), '')::int nulls last`, students.firstName);
  }
  return [];
}

/** May the caller take attendance for this offering/section? Ownership is checked against DB assignments. */
export async function assertCanTake(ctx: TenantContext, target: { courseOfferingId?: string | null; sectionId?: string | null }, conn: DbOrTx = db) {
  if (ctx.permissions.has('attendance.take.any')) return;
  if (!ctx.permissions.has('attendance.take') || !ctx.staffId) throw forbidden('You are not allowed to take attendance');
  if (target.courseOfferingId) {
    const [o] = await conn.select({ staffId: courseOfferings.staffId, ct: sections.classTeacherStaffId }).from(courseOfferings).leftJoin(sections, eq(sections.id, courseOfferings.sectionId))
      .where(and(eq(courseOfferings.id, target.courseOfferingId), eq(courseOfferings.institutionId, ctx.institutionId)));
    if (!o) throw notFound('Course offering');
    if (o.staffId === ctx.staffId || o.ct === ctx.staffId) return;
    throw forbidden('This class is not assigned to you');
  }
  if (target.sectionId) {
    const [sec] = await conn.select({ ct: sections.classTeacherStaffId }).from(sections).where(and(eq(sections.id, target.sectionId), eq(sections.institutionId, ctx.institutionId)));
    if (!sec) throw notFound('Section');
    if (sec.ct === ctx.staffId) return;
    throw forbidden('Only the class teacher can take this register');
  }
  throw forbidden();
}

/** Converts a wall-clock time in an IANA zone into a UTC Date. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const guess = new Date(`${date}T${time.length === 5 ? time + ':00' : time}Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(guess).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guess.getTime() - (asIfUtc - guess.getTime()));
}

export async function submissionDeadline(s: Session, policy: Policy, tz: string, conn: DbOrTx = db) {
  let start = '00:00';
  if (s.periodId) {
    const [p] = await conn.select({ t: periods.startTime }).from(periods).where(eq(periods.id, s.periodId));
    if (p) start = p.t;
  }
  return new Date(zonedToUtc(s.sessionDate, start, tz).getTime() + policy.submissionDeadlineMinutes * 60_000);
}

export interface MarkInput { studentId: string; status: AttendanceStatus; remarks?: string | null }

export function validateMarks(marks: MarkInput[], rosterIds: Set<string>, policy: Policy) {
  const allowed = new Set([...policy.enabledStatuses, 'pending_verification', 'holiday', 'not_applicable']);
  const seen = new Set<string>();
  for (const m of marks) {
    if (!rosterIds.has(m.studentId)) throw new AppError(400, 'NOT_IN_ROSTER', `Student ${m.studentId} is not on this class roster`);
    if (!allowed.has(m.status)) throw new AppError(400, 'STATUS_DISABLED', `Status "${m.status}" is not enabled for this institution`);
    if (seen.has(m.studentId)) throw new AppError(400, 'DUPLICATE_MARK', 'A student appears more than once');
    seen.add(m.studentId);
  }
}

/** Upserts marks for an open session (draft save). Never touches submitted sessions. */
export async function saveMarks(tx: DbOrTx, s: Session, marks: MarkInput[], userId: string, method: Session['method'] = 'manual') {
  if (!marks.length) return;
  await tx.insert(attendanceRecords).values(marks.map((m) => ({
    institutionId: s.institutionId, sessionId: s.id, studentId: m.studentId, status: m.status, remarks: m.remarks ?? null, markedByUserId: userId, method,
  }))).onConflictDoUpdate({
    target: [attendanceRecords.sessionId, attendanceRecords.studentId],
    set: { status: sql`excluded.status`, remarks: sql`excluded.remarks`, markedByUserId: sql`excluded.marked_by_user_id`, markedAt: sql`now()`, method: sql`excluded.method`, updatedAt: sql`now()` },
  });
}

/** After submission: in-app notifications to linked guardians (and the student) for absences/late, per institution settings. */
export async function notifyForSession(tx: DbOrTx, s: Session) {
  const [settings] = await tx.select({ ns: institutionSettings.notificationSettings }).from(institutionSettings).where(eq(institutionSettings.institutionId, s.institutionId));
  const ns = (settings?.ns ?? {}) as { notifyAbsent?: boolean; notifyLate?: boolean };
  const statuses: AttendanceStatus[] = [];
  if (ns.notifyAbsent !== false) statuses.push('absent');
  if (ns.notifyLate !== false) statuses.push('late');
  if (!statuses.length) return 0;
  const recs = await tx.select({ studentId: attendanceRecords.studentId, status: attendanceRecords.status, first: students.firstName, last: students.lastName, studentUser: students.userId })
    .from(attendanceRecords).innerJoin(students, eq(students.id, attendanceRecords.studentId))
    .where(and(eq(attendanceRecords.sessionId, s.id), inArray(attendanceRecords.status, statuses)));
  if (!recs.length) return 0;
  const links = await tx.select({ studentId: studentGuardians.studentId, userId: guardians.userId }).from(studentGuardians).innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .where(and(inArray(studentGuardians.studentId, recs.map((r) => r.studentId)), eq(studentGuardians.receivesNotifications, true), isNotNull(guardians.userId)));
  let label = 'the daily register';
  if (s.courseOfferingId) {
    const [o] = await tx.select({ name: subjects.name }).from(courseOfferings).innerJoin(subjects, eq(subjects.id, courseOfferings.subjectId)).where(eq(courseOfferings.id, s.courseOfferingId));
    if (o) label = o.name;
  }
  let n = 0;
  for (const r of recs) {
    const name = `${r.first} ${r.last}`.trim();
    const word = r.status === 'absent' ? 'absent' : 'late';
    const recipients = links.filter((l) => l.studentId === r.studentId).map((l) => l.userId!).concat(r.studentUser ? [r.studentUser] : []);
    const rows = await notify(tx, {
      institutionId: s.institutionId, recipientUserIds: recipients, eventKey: `attendance.${word}`,
      title: `${name} marked ${word}`, body: `${name} was marked ${word} for ${label} on ${s.sessionDate}.`,
      data: { studentId: r.studentId, sessionId: s.id, date: s.sessionDate },
    });
    n += rows.length;
  }
  return n;
}
