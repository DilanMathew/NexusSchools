import { Router } from 'express';
import { z } from 'zod';
import { and, asc, count, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { studentLeaveRequests, leaveTypes, students, studentGuardians, guardians, users, studentEnrolments, sections } from '../../db/schema/index.js';
import { parse, paginationSchema, pageMeta, uuidParam, isoDate } from '../../lib/http.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { auditReq } from '../../lib/audit.js';
import { requirePermission } from '../../middleware/auth.js';
import { attendanceScope } from '../attendance/scope.js';
import { notify } from '../notifications/service.js';

/**
 * Student leave. Approval records the decision; it does NOT rewrite attendance records. Attendance
 * percentages treat leave according to the institution's attendance policy.
 */
export const leaveRouter = Router();

leaveRouter.get('/types', async (req, res) => {
  res.json({ data: await db.select().from(leaveTypes).where(and(eq(leaveTypes.institutionId, req.ctx!.institutionId), eq(leaveTypes.isActive, true))).orderBy(asc(leaveTypes.name)) });
});

leaveRouter.post('/requests', requirePermission('leave.request'), async (req, res) => {
  const ctx = req.ctx!;
  const body = parse(z.object({ studentId: z.string().uuid(), leaveTypeId: z.string().uuid(), startDate: isoDate, endDate: isoDate, isPartialDay: z.boolean().default(false), reason: z.string().trim().min(5).max(1000) }), req.body);
  if (body.startDate > body.endDate) throw badRequest('Start date must be on or before end date');
  const own = ctx.studentId === body.studentId;
  const child = ctx.guardianId ? (await db.select().from(studentGuardians).where(and(eq(studentGuardians.guardianId, ctx.guardianId), eq(studentGuardians.studentId, body.studentId)))).length > 0 : false;
  if (!own && !child) throw forbidden('You can only apply for leave for yourself or your linked children');
  const [lt] = await db.select().from(leaveTypes).where(and(eq(leaveTypes.id, body.leaveTypeId), eq(leaveTypes.institutionId, ctx.institutionId)));
  if (!lt) throw badRequest('Unknown leave type');
  const overlap = await db.select({ id: studentLeaveRequests.id }).from(studentLeaveRequests).where(and(eq(studentLeaveRequests.studentId, body.studentId), inArray(studentLeaveRequests.status, ['pending', 'approved']), sql`${studentLeaveRequests.startDate} <= ${body.endDate} and ${studentLeaveRequests.endDate} >= ${body.startDate}`));
  if (overlap.length) throw new AppError(409, 'OVERLAP', 'There is already a pending or approved leave request covering these dates');
  const r = await db.transaction(async (tx) => {
    const [r] = await tx.insert(studentLeaveRequests).values({ ...body, institutionId: ctx.institutionId, requestedByUserId: req.auth!.userId }).returning();
    await auditReq(tx, req, { action: 'leave.requested', entityType: 'student_leave', entityId: r.id, after: r });
    // Notify the class teacher.
    const [ct] = await tx.select({ userId: sql<string | null>`(select s.user_id from staff s where s.id = ${sections.classTeacherStaffId})` }).from(studentEnrolments).innerJoin(sections, eq(sections.id, studentEnrolments.sectionId)).where(and(eq(studentEnrolments.studentId, body.studentId), eq(studentEnrolments.isActive, true)));
    if (ct?.userId) await notify(tx, { institutionId: ctx.institutionId, recipientUserIds: [ct.userId], eventKey: 'leave.submitted', title: 'New leave request', body: `A ${lt.name.toLowerCase()} leave request was submitted for ${body.startDate} – ${body.endDate}.`, data: { leaveRequestId: r.id } });
    return r;
  });
  res.status(201).json({ data: r });
});

leaveRouter.get('/requests', async (req, res) => {
  const ctx = req.ctx!;
  const p = parse(paginationSchema.extend({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), studentId: z.string().uuid().optional() }), req.query);
  let restrict;
  if (ctx.permissions.has('leave.review')) {
    const scope = await attendanceScope(ctx);
    restrict = scope.all ? undefined : (scope.rosterSectionIds.length ? inArray(studentEnrolments.sectionId, scope.rosterSectionIds) : sql`false`);
  } else {
    const kids = ctx.guardianId ? (await db.select({ id: studentGuardians.studentId }).from(studentGuardians).where(eq(studentGuardians.guardianId, ctx.guardianId))).map((k) => k.id) : [];
    const ids = [...kids, ...(ctx.studentId ? [ctx.studentId] : [])];
    restrict = or(eq(studentLeaveRequests.requestedByUserId, req.auth!.userId), ids.length ? inArray(studentLeaveRequests.studentId, ids) : sql`false`);
  }
  const where = and(eq(studentLeaveRequests.institutionId, ctx.institutionId), p.status ? eq(studentLeaveRequests.status, p.status) : undefined, p.studentId ? eq(studentLeaveRequests.studentId, p.studentId) : undefined, restrict);
  const from = () => db.select({ r: studentLeaveRequests, typeName: leaveTypes.name, studentName: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, admissionNumber: students.admissionNumber, requestedBy: users.fullName })
    .from(studentLeaveRequests).innerJoin(leaveTypes, eq(leaveTypes.id, studentLeaveRequests.leaveTypeId)).innerJoin(students, eq(students.id, studentLeaveRequests.studentId))
    .leftJoin(studentEnrolments, and(eq(studentEnrolments.studentId, students.id), eq(studentEnrolments.isActive, true))).leftJoin(users, eq(users.id, studentLeaveRequests.requestedByUserId));
  const [{ total }] = await db.select({ total: count() }).from(studentLeaveRequests).innerJoin(students, eq(students.id, studentLeaveRequests.studentId)).leftJoin(studentEnrolments, and(eq(studentEnrolments.studentId, students.id), eq(studentEnrolments.isActive, true))).where(where);
  const rows = await from().where(where).orderBy(desc(studentLeaveRequests.createdAt)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({ data: rows.map((x) => ({ ...x.r, typeName: x.typeName, studentName: x.studentName, admissionNumber: x.admissionNumber, requestedBy: x.requestedBy })), meta: pageMeta(p, total) });
});

leaveRouter.post('/requests/:id/review', requirePermission('leave.review'), async (req, res) => {
  const ctx = req.ctx!;
  const id = parse(uuidParam, req.params.id);
  const body = parse(z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(500).optional() }), req.body);
  if (body.decision === 'rejected' && !body.note) throw badRequest('Please give a reason for rejecting');
  const out = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(studentLeaveRequests).where(and(eq(studentLeaveRequests.id, id), eq(studentLeaveRequests.institutionId, ctx.institutionId))).for('update');
    if (!r) throw notFound('Leave request');
    if (r.status !== 'pending') throw new AppError(409, 'ALREADY_REVIEWED', 'This request has already been reviewed');
    const scope = await attendanceScope(ctx);
    if (!scope.all) {
      const [en] = await tx.select({ sectionId: studentEnrolments.sectionId }).from(studentEnrolments).where(and(eq(studentEnrolments.studentId, r.studentId), eq(studentEnrolments.isActive, true)));
      if (!en || !scope.rosterSectionIds.includes(en.sectionId)) throw forbidden('This student is not in your classes');
    }
    const [after] = await tx.update(studentLeaveRequests).set({ status: body.decision, reviewNote: body.note, reviewerUserId: req.auth!.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(studentLeaveRequests.id, id)).returning();
    await auditReq(tx, req, { action: `leave.${body.decision}`, entityType: 'student_leave', entityId: id, before: { status: r.status }, after: { status: body.decision, note: body.note } });
    const g = await tx.select({ userId: guardians.userId }).from(studentGuardians).innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId)).where(and(eq(studentGuardians.studentId, r.studentId), isNotNull(guardians.userId)));
    const [st] = await tx.select({ userId: students.userId }).from(students).where(eq(students.id, r.studentId));
    await notify(tx, { institutionId: ctx.institutionId, recipientUserIds: [r.requestedByUserId, ...g.map((x) => x.userId!), ...(st?.userId ? [st.userId] : [])], eventKey: `leave.${body.decision}`, title: `Leave request ${body.decision}`, body: `Leave for ${r.startDate} – ${r.endDate} was ${body.decision}.${body.note ? ' Note: ' + body.note : ''}`, data: { leaveRequestId: id } });
    return after;
  });
  res.json({ data: out });
});

leaveRouter.post('/requests/:id/cancel', requirePermission('leave.request'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const [r] = await db.select().from(studentLeaveRequests).where(and(eq(studentLeaveRequests.id, id), eq(studentLeaveRequests.institutionId, req.ctx!.institutionId), eq(studentLeaveRequests.requestedByUserId, req.auth!.userId)));
  if (!r) throw notFound('Leave request');
  if (r.status !== 'pending') throw new AppError(409, 'NOT_PENDING', 'Only pending requests can be cancelled');
  await db.update(studentLeaveRequests).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(studentLeaveRequests.id, id));
  await auditReq(db, req, { action: 'leave.cancelled', entityType: 'student_leave', entityId: id });
  res.json({ data: { ok: true } });
});
