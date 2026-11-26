import { Router } from 'express';
import { z } from 'zod';
import { and, asc, count, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  attendancePolicies, attendanceSessions, attendanceRecords, attendanceCorrections, attendanceCorrectionRequests,
  courseOfferings, sections, classLevels, subjects, students, periods, timetableEntries, staff, rooms, institutionSettings,
  calendarEvents, users, ATTENDANCE_STATUSES, studentGuardians,
} from '../../db/schema/index.js';
import { parse, paginationSchema, pageMeta, uuidParam, isoDate } from '../../lib/http.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { auditReq } from '../../lib/audit.js';
import { assertOwned } from '../../lib/tenant-crud.js';
import { requirePermission, can } from '../../middleware/auth.js';
import { isoWeekday, todayIn } from '../../lib/dates.js';
import { attendanceScope, assertCanViewStudent } from './scope.js';
import {
  assertCanTake, getDefaultPolicy, getRoster, getSession, notifyForSession, saveMarks, submissionDeadline, validateMarks, asPolicyInput,
} from './service.js';
import { policySnapshot } from './engine.js';
import { studentSummary } from './summary.js';
import { notify } from '../notifications/service.js';

export const attendanceRouter = Router();
const statusEnum = z.enum(ATTENDANCE_STATUSES);
const markSchema = z.object({ studentId: z.string().uuid(), status: statusEnum, remarks: z.string().max(300).nullable().optional() });

// ---------------- Policy ----------------
attendanceRouter.get('/policy', async (req, res) => {
  const p = await getDefaultPolicy(req.ctx!.institutionId);
  res.json({ data: p });
});

const policySchema = z.object({
  name: z.string().min(2).max(80).optional(),
  calculationUnit: z.enum(['session', 'day']).optional(),
  enabledStatuses: z.array(statusEnum).min(2).optional(),
  lateWeight: z.number().min(0).max(1).optional(),
  halfDayWeight: z.number().min(0).max(1).optional(),
  onDutyCountsAsPresent: z.boolean().optional(),
  approvedLeaveHandling: z.enum(['exclude', 'present', 'absent']).optional(),
  medicalLeaveHandling: z.enum(['exclude', 'present', 'absent']).optional(),
  excusedHandling: z.enum(['exclude', 'present', 'absent']).optional(),
  excludeHolidays: z.boolean().optional(),
  excludeCancelledSessions: z.boolean().optional(),
  separateLabAndTheory: z.boolean().optional(),
  eligibilityThreshold: z.number().min(0).max(100).optional(),
  warningThreshold: z.number().min(0).max(100).optional(),
  submissionDeadlineMinutes: z.number().int().min(5).max(60 * 24 * 14).optional(),
  teacherEditWindowMinutes: z.number().int().min(0).max(60 * 24 * 7).optional(),
  lateAfterMinutes: z.number().int().min(0).max(180).optional(),
});

attendanceRouter.put('/policy', requirePermission('attendance.policy.manage'), async (req, res) => {
  const body = parse(policySchema, req.body);
  const before = await getDefaultPolicy(req.ctx!.institutionId);
  const elig = body.eligibilityThreshold ?? Number(before.eligibilityThreshold);
  const warn = body.warningThreshold ?? Number(before.warningThreshold);
  if (warn < elig) throw badRequest('Warning threshold must be greater than or equal to the eligibility threshold');
  if (body.enabledStatuses && !(body.enabledStatuses.includes('present') && body.enabledStatuses.includes('absent'))) throw badRequest('Present and Absent must remain enabled');
  const [after] = await db.update(attendancePolicies).set({
    ...body,
    lateWeight: body.lateWeight?.toString(), halfDayWeight: body.halfDayWeight?.toString(),
    eligibilityThreshold: body.eligibilityThreshold?.toString(), warningThreshold: body.warningThreshold?.toString(),
    version: before.version + 1, updatedAt: new Date(),
  }).where(eq(attendancePolicies.id, before.id)).returning();
  await auditReq(db, req, { action: 'attendance_policy.updated', entityType: 'attendance_policy', entityId: before.id, before: policySnapshot(asPolicyInput(before)), after: policySnapshot(asPolicyInput(after)) });
  res.json({ data: after });
});

// ---------------- Today (teacher workspace) ----------------
attendanceRouter.get('/today', requirePermission('attendance.take', 'attendance.take.any'), async (req, res) => {
  const ctx = req.ctx!;
  const date = parse(isoDate.optional(), req.query.date) ?? todayIn(ctx.timezone);
  const dow = isoWeekday(date);
  const mineOnly = !ctx.permissions.has('attendance.take.any') || req.query.mine === 'true';
  if (mineOnly && !ctx.staffId) return res.json({ data: { date, isHoliday: false, holiday: null, periods: [], registers: [] } });
  const [holiday] = await db.select().from(calendarEvents).where(and(eq(calendarEvents.institutionId, ctx.institutionId), inArray(calendarEvents.kind, ['holiday', 'vacation']), lte(calendarEvents.startDate, date), gte(calendarEvents.endDate, date)));
  const [settings] = await db.select().from(institutionSettings).where(eq(institutionSettings.institutionId, ctx.institutionId));

  const entries = await db.select({
    entryId: timetableEntries.id, periodId: periods.id, periodName: periods.name, startTime: periods.startTime, endTime: periods.endTime, ordinal: periods.ordinal,
    offeringId: courseOfferings.id, subjectName: subjects.name, subjectCode: subjects.code, subjectKind: subjects.kind,
    sectionId: sections.id, sectionName: sections.name, classLevelName: classLevels.name, roomName: rooms.name, staffName: staff.fullName, label: courseOfferings.label,
  }).from(timetableEntries)
    .innerJoin(courseOfferings, eq(courseOfferings.id, timetableEntries.courseOfferingId))
    .innerJoin(subjects, eq(subjects.id, courseOfferings.subjectId))
    .innerJoin(periods, eq(periods.id, timetableEntries.periodId))
    .leftJoin(sections, eq(sections.id, courseOfferings.sectionId))
    .leftJoin(classLevels, eq(classLevels.id, sections.classLevelId))
    .leftJoin(rooms, eq(rooms.id, timetableEntries.roomId))
    .leftJoin(staff, eq(staff.id, courseOfferings.staffId))
    .where(and(eq(timetableEntries.institutionId, ctx.institutionId), eq(timetableEntries.dayOfWeek, dow),
      or(sql`${timetableEntries.effectiveFrom} is null`, lte(timetableEntries.effectiveFrom, date)), or(sql`${timetableEntries.effectiveTo} is null`, gte(timetableEntries.effectiveTo, date)),
      mineOnly ? eq(courseOfferings.staffId, ctx.staffId!) : undefined))
    .orderBy(asc(periods.ordinal)).limit(500);

  // Daily-register institutions do not take per-period attendance unless the module is enabled.
  if (settings?.modules?.periodAttendance === false && settings?.modules?.subjectAttendance !== true) entries.splice(0);
  const sess = entries.length ? await db.select({ id: attendanceSessions.id, offeringId: attendanceSessions.courseOfferingId, periodId: attendanceSessions.periodId, status: attendanceSessions.status, submittedAt: attendanceSessions.submittedAt })
    .from(attendanceSessions).where(and(eq(attendanceSessions.institutionId, ctx.institutionId), eq(attendanceSessions.sessionDate, date), inArray(attendanceSessions.courseOfferingId, entries.map((e) => e.offeringId)))) : [];

  let registers: unknown[] = [];
  if (settings?.modules?.dailyAttendance) {
    const secs = await db.select({ sectionId: sections.id, sectionName: sections.name, classLevelName: classLevels.name }).from(sections).innerJoin(classLevels, eq(classLevels.id, sections.classLevelId))
      .where(and(eq(sections.institutionId, ctx.institutionId), mineOnly ? eq(sections.classTeacherStaffId, ctx.staffId!) : undefined)).orderBy(asc(classLevels.ordinal), asc(sections.name)).limit(300);
    const ds = secs.length ? await db.select({ id: attendanceSessions.id, sectionId: attendanceSessions.sectionId, status: attendanceSessions.status }).from(attendanceSessions)
      .where(and(eq(attendanceSessions.kind, 'daily'), eq(attendanceSessions.sessionDate, date), inArray(attendanceSessions.sectionId, secs.map((s) => s.sectionId)), ne(attendanceSessions.status, 'cancelled'))) : [];
    registers = secs.map((s) => ({ ...s, session: ds.find((d) => d.sectionId === s.sectionId) ?? null }));
  }
  res.json({ data: {
    date, isHoliday: !!holiday, holiday: holiday ?? null, isWorkingDay: settings?.workingDays?.includes(dow) ?? true,
    periods: entries.map((e) => ({ ...e, session: sess.find((s) => s.offeringId === e.offeringId && s.periodId === e.periodId && s.status !== 'cancelled') ?? null })),
    registers,
  } });
});

// ---------------- Sessions ----------------
const startSchema = z.object({
  kind: z.enum(['daily', 'period', 'subject', 'lab', 'practical', 'assembly', 'event', 'exam', 'transport']),
  date: isoDate,
  courseOfferingId: z.string().uuid().nullable().optional(),
  sectionId: z.string().uuid().nullable().optional(),
  periodId: z.string().uuid().nullable().optional(),
  timetableEntryId: z.string().uuid().nullable().optional(),
  title: z.string().max(120).optional(),
});

/** Start (or resume) a session. Idempotent per slot: returns the existing live session if one exists. */
attendanceRouter.post('/sessions', requirePermission('attendance.take', 'attendance.take.any'), async (req, res) => {
  const body = parse(startSchema, req.body);
  const ctx = req.ctx!;
  if (!body.courseOfferingId && !body.sectionId) throw badRequest('courseOfferingId or sectionId is required');
  if (body.kind === 'daily' && !body.sectionId) throw badRequest('Daily registers require a sectionId');
  await assertOwned(db, ctx.institutionId, [[courseOfferings, body.courseOfferingId], [sections, body.sectionId], [periods, body.periodId], [timetableEntries, body.timetableEntryId]]);
  await assertCanTake(ctx, body);
  if (body.date > todayIn(ctx.timezone)) throw badRequest('Attendance cannot be taken for a future date');

  const slot = body.courseOfferingId
    ? and(eq(attendanceSessions.courseOfferingId, body.courseOfferingId), eq(attendanceSessions.sessionDate, body.date), body.periodId ? eq(attendanceSessions.periodId, body.periodId) : sql`${attendanceSessions.periodId} is null`)
    : and(eq(attendanceSessions.sectionId, body.sectionId!), eq(attendanceSessions.sessionDate, body.date), eq(attendanceSessions.kind, body.kind), sql`${attendanceSessions.courseOfferingId} is null`);
  const [existing] = await db.select().from(attendanceSessions).where(and(eq(attendanceSessions.institutionId, ctx.institutionId), ne(attendanceSessions.status, 'cancelled'), slot));
  if (existing) return res.json({ data: existing, meta: { resumed: true } });

  let sectionId = body.sectionId ?? null;
  if (body.courseOfferingId && !sectionId) {
    const [o] = await db.select({ s: courseOfferings.sectionId }).from(courseOfferings).where(eq(courseOfferings.id, body.courseOfferingId));
    sectionId = o?.s ?? null;
  }
  try {
    const [s] = await db.insert(attendanceSessions).values({
      institutionId: ctx.institutionId, kind: body.kind, sessionDate: body.date, courseOfferingId: body.courseOfferingId ?? null, sectionId,
      periodId: body.periodId ?? null, timetableEntryId: body.timetableEntryId ?? null, takenByStaffId: ctx.staffId, title: body.title, method: 'manual',
    }).returning();
    await auditReq(db, req, { action: 'attendance_session.started', entityType: 'attendance_session', entityId: s.id, after: s });
    res.status(201).json({ data: s, meta: { resumed: false } });
  } catch (e) {
    // Race: another request created it first.
    const [again] = await db.select().from(attendanceSessions).where(and(eq(attendanceSessions.institutionId, ctx.institutionId), ne(attendanceSessions.status, 'cancelled'), slot));
    if (again) return res.json({ data: again, meta: { resumed: true } });
    throw e;
  }
});

attendanceRouter.get('/sessions', requirePermission('attendance.read', 'attendance.read.department', 'attendance.read.assigned'), async (req, res) => {
  const p = parse(paginationSchema.extend({ from: isoDate.optional(), to: isoDate.optional(), sectionId: z.string().uuid().optional(), courseOfferingId: z.string().uuid().optional(), status: z.enum(['open', 'submitted', 'locked', 'cancelled']).optional() }), req.query);
  const scope = await attendanceScope(req.ctx!);
  const where = and(eq(attendanceSessions.institutionId, req.ctx!.institutionId),
    p.from ? gte(attendanceSessions.sessionDate, p.from) : undefined, p.to ? lte(attendanceSessions.sessionDate, p.to) : undefined,
    p.sectionId ? eq(attendanceSessions.sectionId, p.sectionId) : undefined, p.courseOfferingId ? eq(attendanceSessions.courseOfferingId, p.courseOfferingId) : undefined,
    p.status ? eq(attendanceSessions.status, p.status) : undefined,
    scope.all ? undefined : or(scope.sectionIds.length ? inArray(attendanceSessions.sectionId, scope.sectionIds) : sql`false`, scope.offeringIds.length ? inArray(attendanceSessions.courseOfferingId, scope.offeringIds) : sql`false`));
  const [{ total }] = await db.select({ total: count() }).from(attendanceSessions).where(where);
  const rows = await db.select({
    s: attendanceSessions, subjectName: subjects.name, sectionName: sections.name, classLevelName: classLevels.name, periodName: periods.name, takenBy: staff.fullName,
    present: sql<number>`(select count(*)::int from attendance_records r where r.session_id = ${attendanceSessions.id} and r.status in ('present','late','on_duty'))`,
    absent: sql<number>`(select count(*)::int from attendance_records r where r.session_id = ${attendanceSessions.id} and r.status = 'absent')`,
    marked: sql<number>`(select count(*)::int from attendance_records r where r.session_id = ${attendanceSessions.id})`,
  }).from(attendanceSessions)
    .leftJoin(courseOfferings, eq(courseOfferings.id, attendanceSessions.courseOfferingId)).leftJoin(subjects, eq(subjects.id, courseOfferings.subjectId))
    .leftJoin(sections, eq(sections.id, attendanceSessions.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId))
    .leftJoin(periods, eq(periods.id, attendanceSessions.periodId)).leftJoin(staff, eq(staff.id, attendanceSessions.takenByStaffId))
    .where(where).orderBy(desc(attendanceSessions.sessionDate), asc(periods.ordinal)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({ data: rows.map((r) => ({ ...r.s, subjectName: r.subjectName, sectionName: r.sectionName, classLevelName: r.classLevelName, periodName: r.periodName, takenBy: r.takenBy, present: r.present, absent: r.absent, marked: r.marked })), meta: pageMeta(p, total) });
});

attendanceRouter.get('/sessions/:id', requirePermission('attendance.take', 'attendance.take.any', 'attendance.read', 'attendance.read.department', 'attendance.read.assigned'), async (req, res) => {
  const ctx = req.ctx!;
  const s = await getSession(ctx.institutionId, parse(uuidParam, req.params.id));
  const scope = await attendanceScope(ctx);
  const visible = scope.all || (s.sectionId && scope.sectionIds.includes(s.sectionId)) || (s.courseOfferingId && scope.offeringIds.includes(s.courseOfferingId));
  if (!visible) { try { await assertCanTake(ctx, s); } catch { throw notFound('Attendance session'); } }
  const roster = await getRoster(db, s);
  const recs = await db.select().from(attendanceRecords).where(eq(attendanceRecords.sessionId, s.id));
  // Students who have a record but have since left the roster are still shown (history is never hidden).
  const extra = recs.filter((r) => !roster.some((x) => x.id === r.studentId)).map((r) => r.studentId);
  const extraStudents = extra.length ? await db.select({ id: students.id, firstName: students.firstName, lastName: students.lastName, admissionNumber: students.admissionNumber, photoUrl: students.photoUrl, userId: students.userId }).from(students).where(inArray(students.id, extra)) : [];
  const policy = await getDefaultPolicy(ctx.institutionId);
  let meta: Record<string, unknown> = {};
  if (s.courseOfferingId) {
    const [o] = await db.select({ subjectName: subjects.name, subjectCode: subjects.code, kind: subjects.kind, sectionName: sections.name, classLevelName: classLevels.name })
      .from(courseOfferings).innerJoin(subjects, eq(subjects.id, courseOfferings.subjectId)).leftJoin(sections, eq(sections.id, courseOfferings.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId))
      .where(eq(courseOfferings.id, s.courseOfferingId));
    meta = o ?? {};
  } else if (s.sectionId) {
    const [o] = await db.select({ sectionName: sections.name, classLevelName: classLevels.name }).from(sections).innerJoin(classLevels, eq(classLevels.id, sections.classLevelId)).where(eq(sections.id, s.sectionId));
    meta = o ?? {};
  }
  if (s.periodId) { const [p] = await db.select({ periodName: periods.name, startTime: periods.startTime, endTime: periods.endTime }).from(periods).where(eq(periods.id, s.periodId)); meta = { ...meta, ...p }; }
  const deadline = await submissionDeadline(s, policy, ctx.timezone);
  let canEdit = false;
  try { await assertCanTake(ctx, s); canEdit = true; } catch { /* read-only */ }
  res.json({ data: {
    session: s, ...meta,
    students: [...roster, ...extraStudents.map((x) => ({ ...x, rollNumber: null, leftRoster: true }))].map((st) => {
      const r = recs.find((x) => x.studentId === st.id);
      return { id: st.id, name: `${st.firstName} ${st.lastName}`.trim(), admissionNumber: st.admissionNumber, rollNumber: st.rollNumber, photoUrl: st.photoUrl, leftRoster: 'leftRoster' in st, record: r ? { id: r.id, status: r.status, remarks: r.remarks, method: r.method, version: r.version, markedAt: r.markedAt } : null };
    }),
    enabledStatuses: policy.enabledStatuses, deadline, canEdit,
    editWindowEndsAt: s.submittedAt ? new Date(s.submittedAt.getTime() + policy.teacherEditWindowMinutes * 60_000) : null,
  } });
});

/** Draft save while a session is open. */
attendanceRouter.put('/sessions/:id/records', requirePermission('attendance.take', 'attendance.take.any'), async (req, res) => {
  const ctx = req.ctx!;
  const body = parse(z.object({ records: z.array(markSchema).max(2000) }), req.body);
  const s = await getSession(ctx.institutionId, parse(uuidParam, req.params.id));
  await assertCanTake(ctx, s);
  if (s.status !== 'open') throw new AppError(409, 'SESSION_NOT_OPEN', 'This session is already submitted. Use corrections to change records.');
  const roster = await getRoster(db, s);
  const policy = await getDefaultPolicy(ctx.institutionId);
  validateMarks(body.records, new Set(roster.map((r) => r.id)), policy);
  await db.transaction((tx) => saveMarks(tx, s, body.records, req.auth!.userId));
  res.json({ data: { saved: body.records.length } });
});

/** Final submission: all roster students must be marked. Atomic. */
attendanceRouter.post('/sessions/:id/submit', requirePermission('attendance.take', 'attendance.take.any'), async (req, res) => {
  const ctx = req.ctx!;
  const body = parse(z.object({ records: z.array(markSchema).max(2000).default([]) }), req.body);
  const id = parse(uuidParam, req.params.id);
  const s0 = await getSession(ctx.institutionId, id);
  await assertCanTake(ctx, s0);
  const policy = await getDefaultPolicy(ctx.institutionId);
  if (!ctx.permissions.has('attendance.take.any') && new Date() > await submissionDeadline(s0, policy, ctx.timezone)) {
    throw new AppError(409, 'DEADLINE_PASSED', 'The submission deadline for this session has passed. Ask an administrator to record it.');
  }
  const result = await db.transaction(async (tx) => {
    // Lock the session row so concurrent submits serialise.
    const { rows: [locked] } = await tx.execute<{ status: string }>(sql`select status from attendance_sessions where id = ${id} for update`);
    if (locked.status !== 'open') throw new AppError(409, 'SESSION_NOT_OPEN', 'This session has already been submitted');
    const roster = await getRoster(tx, s0);
    validateMarks(body.records, new Set(roster.map((r) => r.id)), policy);
    await saveMarks(tx, s0, body.records, req.auth!.userId);
    const recs = await tx.select({ studentId: attendanceRecords.studentId, status: attendanceRecords.status }).from(attendanceRecords).where(eq(attendanceRecords.sessionId, id));
    const missing = roster.filter((r) => !recs.some((x) => x.studentId === r.id));
    if (missing.length) throw new AppError(400, 'INCOMPLETE', `${missing.length} student(s) have not been marked`, { studentIds: missing.map((m) => m.id) });
    const [s] = await tx.update(attendanceSessions).set({ status: 'submitted', submittedAt: new Date(), submittedByUserId: req.auth!.userId, updatedAt: new Date() }).where(eq(attendanceSessions.id, id)).returning();
    const tally = recs.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
    await auditReq(tx, req, { action: 'attendance_session.submitted', entityType: 'attendance_session', entityId: id, after: { tally, total: recs.length } });
    const notified = await notifyForSession(tx, s);
    return { session: s, tally, notified };
  });
  res.json({ data: result });
});

attendanceRouter.post('/sessions/:id/cancel', requirePermission('attendance.take', 'attendance.take.any'), async (req, res) => {
  const ctx = req.ctx!;
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
  const s = await getSession(ctx.institutionId, parse(uuidParam, req.params.id));
  await assertCanTake(ctx, s);
  if (s.status !== 'open' && !ctx.permissions.has('attendance.correct')) throw forbidden('Only an administrator can cancel a submitted session');
  const [after] = await db.update(attendanceSessions).set({ status: 'cancelled', cancelledReason: reason, updatedAt: new Date() }).where(eq(attendanceSessions.id, s.id)).returning();
  await auditReq(db, req, { action: 'attendance_session.cancelled', entityType: 'attendance_session', entityId: s.id, before: { status: s.status }, after: { status: 'cancelled', reason } });
  res.json({ data: after });
});

// ---------------- Corrections (direct) ----------------
/**
 * Change a submitted record. The original value is preserved in attendance_corrections.
 * Allowed for: the taker within the policy edit window, or holders of attendance.correct.
 */
attendanceRouter.patch('/records/:id', requirePermission('attendance.take', 'attendance.take.any', 'attendance.correct'), async (req, res) => {
  const ctx = req.ctx!;
  const id = parse(uuidParam, req.params.id);
  const body = parse(z.object({ status: statusEnum, reason: z.string().trim().min(3).max(500), expectedVersion: z.number().int().optional() }), req.body);
  const out = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(attendanceRecords).where(and(eq(attendanceRecords.id, id), eq(attendanceRecords.institutionId, ctx.institutionId))).for('update');
    if (!r) throw notFound('Attendance record');
    const s = await getSession(ctx.institutionId, r.sessionId, tx);
    const policy = await getDefaultPolicy(ctx.institutionId, tx);
    if (!policy.enabledStatuses.includes(body.status) && !['pending_verification', 'not_applicable', 'holiday'].includes(body.status)) throw badRequest(`Status "${body.status}" is not enabled`);
    if (body.expectedVersion !== undefined && body.expectedVersion !== r.version) throw new AppError(409, 'STALE', 'This record was changed by someone else. Reload and try again.');
    if (r.status === body.status) throw badRequest('Record already has this status');
    if (s.status === 'open') throw badRequest('Session is still open; edit it directly');
    if (s.status === 'locked' && !ctx.permissions.has('attendance.correct')) throw forbidden('This session is locked');
    if (!ctx.permissions.has('attendance.correct')) {
      await assertCanTake(ctx, s, tx);
      const windowEnd = (s.submittedAt?.getTime() ?? 0) + policy.teacherEditWindowMinutes * 60_000;
      if (Date.now() > windowEnd) throw new AppError(403, 'EDIT_WINDOW_CLOSED', 'The edit window has closed. Submit a correction request for approval.');
    }
    const [after] = await tx.update(attendanceRecords).set({ status: body.status, version: r.version + 1, updatedAt: new Date() }).where(eq(attendanceRecords.id, id)).returning();
    await tx.insert(attendanceCorrections).values({ institutionId: ctx.institutionId, recordId: id, oldStatus: r.status, newStatus: body.status, reason: body.reason, changedByUserId: req.auth!.userId, approvedByUserId: ctx.permissions.has('attendance.correct') ? req.auth!.userId : null });
    await auditReq(tx, req, { action: 'attendance_record.corrected', entityType: 'attendance_record', entityId: id, before: { status: r.status }, after: { status: body.status }, metadata: { reason: body.reason } });
    return after;
  });
  res.json({ data: out });
});

attendanceRouter.get('/records/:id/history', async (req, res) => {
  const ctx = req.ctx!;
  const id = parse(uuidParam, req.params.id);
  const [r] = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.id, id), eq(attendanceRecords.institutionId, ctx.institutionId)));
  if (!r) throw notFound('Attendance record');
  await assertCanViewStudent(ctx, r.studentId);
  const rows = await db.select({ c: attendanceCorrections, changedBy: users.fullName }).from(attendanceCorrections).leftJoin(users, eq(users.id, attendanceCorrections.changedByUserId)).where(eq(attendanceCorrections.recordId, id)).orderBy(asc(attendanceCorrections.createdAt));
  res.json({ data: { record: r, history: rows.map((x) => ({ ...x.c, changedBy: x.changedBy })) } });
});

// ---------------- Correction requests ----------------
attendanceRouter.post('/correction-requests', requirePermission('attendance.correction.request', 'attendance.child.read'), async (req, res) => {
  const ctx = req.ctx!;
  const body = parse(z.object({ recordId: z.string().uuid(), requestedStatus: statusEnum, reason: z.string().trim().min(10).max(1000) }), req.body);
  const [r] = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.id, body.recordId), eq(attendanceRecords.institutionId, ctx.institutionId)));
  if (!r) throw notFound('Attendance record');
  const own = ctx.studentId === r.studentId;
  const child = ctx.guardianId ? (await db.select().from(studentGuardians).where(and(eq(studentGuardians.guardianId, ctx.guardianId), eq(studentGuardians.studentId, r.studentId)))).length > 0 : false;
  if (!own && !child) throw notFound('Attendance record');
  if (r.status === body.requestedStatus) throw badRequest('The record already has this status');
  const [cr] = await db.insert(attendanceCorrectionRequests).values({ institutionId: ctx.institutionId, recordId: r.id, studentId: r.studentId, requestedByUserId: req.auth!.userId, requestedStatus: body.requestedStatus, reason: body.reason }).returning();
  await auditReq(db, req, { action: 'correction_request.created', entityType: 'correction_request', entityId: cr.id, after: cr });
  res.status(201).json({ data: cr });
});

attendanceRouter.get('/correction-requests', async (req, res) => {
  const ctx = req.ctx!;
  const p = parse(paginationSchema.extend({ status: z.enum(['pending', 'approved', 'rejected', 'info_requested', 'withdrawn']).optional() }), req.query);
  let restrict;
  if (can(req, 'attendance.corrections.review', 'attendance.correct')) {
    const scope = await attendanceScope(ctx);
    restrict = scope.all ? undefined : or(scope.sectionIds.length ? inArray(attendanceSessions.sectionId, scope.sectionIds) : sql`false`, scope.offeringIds.length ? inArray(attendanceSessions.courseOfferingId, scope.offeringIds) : sql`false`);
  } else {
    restrict = eq(attendanceCorrectionRequests.requestedByUserId, req.auth!.userId);
  }
  const where = and(eq(attendanceCorrectionRequests.institutionId, ctx.institutionId), p.status ? eq(attendanceCorrectionRequests.status, p.status) : undefined, restrict);
  const q = () => db.select({ cr: attendanceCorrectionRequests, currentStatus: attendanceRecords.status, sessionDate: attendanceSessions.sessionDate, subjectName: subjects.name, studentName: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, admissionNumber: students.admissionNumber, requestedBy: users.fullName })
    .from(attendanceCorrectionRequests)
    .innerJoin(attendanceRecords, eq(attendanceRecords.id, attendanceCorrectionRequests.recordId))
    .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
    .innerJoin(students, eq(students.id, attendanceCorrectionRequests.studentId))
    .leftJoin(courseOfferings, eq(courseOfferings.id, attendanceSessions.courseOfferingId)).leftJoin(subjects, eq(subjects.id, courseOfferings.subjectId))
    .leftJoin(users, eq(users.id, attendanceCorrectionRequests.requestedByUserId));
  const [{ total }] = await db.select({ total: count() }).from(attendanceCorrectionRequests).innerJoin(attendanceRecords, eq(attendanceRecords.id, attendanceCorrectionRequests.recordId)).innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId)).where(where);
  const rows = await q().where(where).orderBy(desc(attendanceCorrectionRequests.createdAt)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({ data: rows.map((r) => ({ ...r.cr, currentStatus: r.currentStatus, sessionDate: r.sessionDate, subjectName: r.subjectName, studentName: r.studentName, admissionNumber: r.admissionNumber, requestedBy: r.requestedBy })), meta: pageMeta(p, total) });
});

attendanceRouter.post('/correction-requests/:id/review', requirePermission('attendance.corrections.review', 'attendance.correct'), async (req, res) => {
  const ctx = req.ctx!;
  const id = parse(uuidParam, req.params.id);
  const body = parse(z.object({ decision: z.enum(['approved', 'rejected', 'info_requested']), note: z.string().trim().max(500).optional() }), req.body);
  if (body.decision !== 'approved' && !body.note) throw badRequest('A note is required when rejecting or requesting information');
  const out = await db.transaction(async (tx) => {
    const [cr] = await tx.select().from(attendanceCorrectionRequests).where(and(eq(attendanceCorrectionRequests.id, id), eq(attendanceCorrectionRequests.institutionId, ctx.institutionId))).for('update');
    if (!cr) throw notFound('Correction request');
    if (!['pending', 'info_requested'].includes(cr.status)) throw new AppError(409, 'ALREADY_REVIEWED', 'This request has already been decided');
    if (cr.requestedByUserId === req.auth!.userId) throw forbidden('You cannot review your own request');
    const [rec] = await tx.select().from(attendanceRecords).where(eq(attendanceRecords.id, cr.recordId)).for('update');
    const s = await getSession(ctx.institutionId, rec.sessionId, tx);
    const scope = await attendanceScope(ctx);
    if (!scope.all && !(s.sectionId && scope.sectionIds.includes(s.sectionId)) && !(s.courseOfferingId && scope.offeringIds.includes(s.courseOfferingId))) throw forbidden('This request is outside your classes');
    const [after] = await tx.update(attendanceCorrectionRequests).set({ status: body.decision, reviewNote: body.note, reviewerUserId: req.auth!.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(attendanceCorrectionRequests.id, id)).returning();
    if (body.decision === 'approved' && rec.status !== cr.requestedStatus) {
      await tx.update(attendanceRecords).set({ status: cr.requestedStatus, version: rec.version + 1, updatedAt: new Date() }).where(eq(attendanceRecords.id, rec.id));
      await tx.insert(attendanceCorrections).values({ institutionId: ctx.institutionId, recordId: rec.id, oldStatus: rec.status, newStatus: cr.requestedStatus, reason: `Correction request: ${cr.reason}`, changedByUserId: req.auth!.userId, approvedByUserId: req.auth!.userId, correctionRequestId: cr.id });
    }
    await auditReq(tx, req, { action: `correction_request.${body.decision}`, entityType: 'correction_request', entityId: id, before: { status: cr.status, recordStatus: rec.status }, after: { status: body.decision, recordStatus: body.decision === 'approved' ? cr.requestedStatus : rec.status } });
    await notify(tx, { institutionId: ctx.institutionId, recipientUserIds: [cr.requestedByUserId], eventKey: 'attendance.correction', title: `Correction request ${body.decision.replace('_', ' ')}`, body: body.note ?? 'Your attendance correction request was approved.', data: { correctionRequestId: id } });
    return after;
  });
  res.json({ data: out });
});

// ---------------- Student summaries ----------------
attendanceRouter.get('/students/:id/summary', async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  await assertCanViewStudent(req.ctx!, id);
  const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional() }), req.query);
  res.json({ data: await studentSummary(req.ctx!.institutionId, id, q) });
});

attendanceRouter.get('/students/:id/records', async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  await assertCanViewStudent(req.ctx!, id);
  const p = parse(paginationSchema.extend({ from: isoDate.optional(), to: isoDate.optional(), status: statusEnum.optional() }), req.query);
  const where = and(eq(attendanceRecords.studentId, id), eq(attendanceRecords.institutionId, req.ctx!.institutionId), ne(attendanceSessions.status, 'cancelled'), ne(attendanceSessions.status, 'open'),
    p.from ? gte(attendanceSessions.sessionDate, p.from) : undefined, p.to ? lte(attendanceSessions.sessionDate, p.to) : undefined, p.status ? eq(attendanceRecords.status, p.status) : undefined);
  const [{ total }] = await db.select({ total: count() }).from(attendanceRecords).innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId)).where(where);
  const rows = await db.select({ id: attendanceRecords.id, status: attendanceRecords.status, method: attendanceRecords.method, remarks: attendanceRecords.remarks, version: attendanceRecords.version, date: attendanceSessions.sessionDate, kind: attendanceSessions.kind, subjectName: subjects.name, periodName: periods.name, startTime: periods.startTime,
    openRequest: sql<boolean>`exists(select 1 from attendance_correction_requests c where c.record_id = ${attendanceRecords.id} and c.status in ('pending','info_requested'))` })
    .from(attendanceRecords).innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
    .leftJoin(courseOfferings, eq(courseOfferings.id, attendanceSessions.courseOfferingId)).leftJoin(subjects, eq(subjects.id, courseOfferings.subjectId)).leftJoin(periods, eq(periods.id, attendanceSessions.periodId))
    .where(where).orderBy(desc(attendanceSessions.sessionDate), asc(periods.ordinal)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({ data: rows, meta: pageMeta(p, total) });
});

// ---------------- Offline sync ----------------
const syncItem = z.object({
  clientId: z.string().min(1).max(80),
  kind: startSchema.shape.kind,
  date: isoDate,
  courseOfferingId: z.string().uuid().nullable().optional(),
  sectionId: z.string().uuid().nullable().optional(),
  periodId: z.string().uuid().nullable().optional(),
  capturedAt: z.string().datetime(),
  records: z.array(markSchema).min(1).max(2000),
});

/**
 * Offline queue replay. Each item is applied independently; results report applied / conflict / error so the
 * client never silently drops data. Sessions submitted by someone else are never overwritten (conflict).
 */
attendanceRouter.post('/sync', requirePermission('attendance.take', 'attendance.take.any'), async (req, res) => {
  const ctx = req.ctx!;
  const { items } = parse(z.object({ items: z.array(syncItem).min(1).max(50) }), req.body);
  const policy = await getDefaultPolicy(ctx.institutionId);
  const results = [];
  for (const it of items) {
    try {
      await assertOwned(db, ctx.institutionId, [[courseOfferings, it.courseOfferingId], [sections, it.sectionId], [periods, it.periodId]]);
      await assertCanTake(ctx, it);
      const r = await db.transaction(async (tx) => {
        const slot = it.courseOfferingId
          ? and(eq(attendanceSessions.courseOfferingId, it.courseOfferingId), eq(attendanceSessions.sessionDate, it.date), it.periodId ? eq(attendanceSessions.periodId, it.periodId) : sql`${attendanceSessions.periodId} is null`)
          : and(eq(attendanceSessions.sectionId, it.sectionId!), eq(attendanceSessions.sessionDate, it.date), eq(attendanceSessions.kind, it.kind), sql`${attendanceSessions.courseOfferingId} is null`);
        let [s] = await tx.select().from(attendanceSessions).where(and(eq(attendanceSessions.institutionId, ctx.institutionId), ne(attendanceSessions.status, 'cancelled'), slot)).for('update');
        if (s && s.status !== 'open') return { clientId: it.clientId, result: 'conflict' as const, sessionId: s.id, message: 'Attendance for this class was already submitted online; offline copy not applied.' };
        if (!s) {
          let sectionId = it.sectionId ?? null;
          if (it.courseOfferingId && !sectionId) sectionId = (await tx.select({ s: courseOfferings.sectionId }).from(courseOfferings).where(eq(courseOfferings.id, it.courseOfferingId)))[0]?.s ?? null;
          [s] = await tx.insert(attendanceSessions).values({ institutionId: ctx.institutionId, kind: it.kind, sessionDate: it.date, courseOfferingId: it.courseOfferingId ?? null, sectionId, periodId: it.periodId ?? null, takenByStaffId: ctx.staffId, method: 'offline' }).returning();
        }
        const roster = await getRoster(tx, s);
        validateMarks(it.records, new Set(roster.map((x) => x.id)), policy);
        await saveMarks(tx, s, it.records, req.auth!.userId, 'offline');
        const captured = new Date(it.capturedAt);
        // Client clocks are untrusted: flag for verification if the timestamp is in the future or not on the session date.
        const suspicious = captured.getTime() > Date.now() + 5 * 60_000 || todayIn(ctx.timezone, captured) !== it.date;
        const marked = await tx.select({ n: count() }).from(attendanceRecords).where(eq(attendanceRecords.sessionId, s.id));
        const complete = marked[0].n >= roster.length;
        await tx.update(attendanceSessions).set({ clientCapturedAt: captured, requiresVerification: suspicious, ...(complete ? { status: 'submitted' as const, submittedAt: new Date(), submittedByUserId: req.auth!.userId } : {}), updatedAt: new Date() }).where(eq(attendanceSessions.id, s.id));
        await auditReq(tx, req, { action: 'attendance_session.offline_synced', entityType: 'attendance_session', entityId: s.id, metadata: { clientId: it.clientId, capturedAt: it.capturedAt, suspicious, complete } });
        if (complete) await notifyForSession(tx, { ...s, status: 'submitted' });
        return { clientId: it.clientId, result: 'applied' as const, sessionId: s.id, submitted: complete, requiresVerification: suspicious };
      });
      results.push(r);
    } catch (e) {
      results.push({ clientId: it.clientId, result: 'error' as const, message: e instanceof AppError ? e.message : 'Unexpected error' });
    }
  }
  res.json({ data: { results } });
});
