import { Router } from 'express';
import { z } from 'zod';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { staff, departments, roles, courseOfferings, subjects, sections, classLevels, timetableEntries, staffLeaveRequests } from '../../db/schema/index.js';
import { parse, paginationSchema, pageMeta, uuidParam, isoDate } from '../../lib/http.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { auditReq } from '../../lib/audit.js';
import { assertOwned } from '../../lib/tenant-crud.js';
import { requirePermission } from '../../middleware/auth.js';
import { createOrAttachUser } from '../users/routes.js';

export const staffRouter = Router();

const fields = {
  employeeId: z.string().trim().min(1).max(40),
  fullName: z.string().trim().min(2).max(120),
  email: z.string().email().max(200).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  designation: z.string().max(80).nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  employmentStatus: z.enum(['active', 'on_leave', 'resigned', 'retired', 'inactive']).optional(),
  joiningDate: isoDate.nullable().optional(),
};

staffRouter.get('/', requirePermission('staff.read', 'staff.manage', 'academic.manage'), async (req, res) => {
  const p = parse(paginationSchema.extend({ departmentId: z.string().uuid().optional(), pageSize: z.coerce.number().int().min(1).max(500).default(50) }), req.query);
  const where = and(eq(staff.institutionId, req.ctx!.institutionId), isNull(staff.deletedAt),
    p.departmentId ? eq(staff.departmentId, p.departmentId) : undefined,
    p.search ? sql`(${staff.fullName} ILIKE ${'%' + p.search + '%'} OR ${staff.employeeId} ILIKE ${'%' + p.search + '%'})` : undefined);
  const [{ total }] = await db.select({ total: count() }).from(staff).where(where);
  const rows = await db.select({ staff, departmentName: departments.name, hasLogin: sql<boolean>`${staff.userId} is not null`,
    offeringCount: sql<number>`(select count(*)::int from course_offerings o where o.staff_id = ${staff.id})`,
    weeklyPeriods: sql<number>`(select count(*)::int from timetable_entries t join course_offerings o on o.id = t.course_offering_id where o.staff_id = ${staff.id})` })
    .from(staff).leftJoin(departments, eq(departments.id, staff.departmentId)).where(where).orderBy(asc(staff.fullName)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({ data: rows.map((r) => ({ ...r.staff, departmentName: r.departmentName, hasLogin: r.hasLogin, offeringCount: r.offeringCount, weeklyPeriods: r.weeklyPeriods })), meta: pageMeta(p, total) });
});

staffRouter.get('/:id', requirePermission('staff.read', 'staff.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const [s] = await db.select().from(staff).where(and(eq(staff.id, id), eq(staff.institutionId, req.ctx!.institutionId), isNull(staff.deletedAt)));
  if (!s) throw notFound('Staff member');
  const offerings = await db.select({ id: courseOfferings.id, subject: subjects.name, subjectCode: subjects.code, kind: subjects.kind, section: sections.name, classLevel: classLevels.name, label: courseOfferings.label })
    .from(courseOfferings).innerJoin(subjects, eq(subjects.id, courseOfferings.subjectId)).leftJoin(sections, eq(sections.id, courseOfferings.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId))
    .where(eq(courseOfferings.staffId, id));
  const [{ periods }] = await db.select({ periods: count() }).from(timetableEntries).innerJoin(courseOfferings, eq(courseOfferings.id, timetableEntries.courseOfferingId)).where(eq(courseOfferings.staffId, id));
  res.json({ data: { ...s, offerings, workload: { offerings: offerings.length, weeklyPeriods: periods } } });
});

staffRouter.post('/', requirePermission('staff.manage'), async (req, res) => {
  const body = parse(z.object({ ...fields, login: z.object({ email: z.string().email(), password: z.string().min(1).max(128), roleKeys: z.array(z.string()).min(1).default(['faculty']) }).optional() }), req.body);
  const inst = req.ctx!.institutionId;
  const s = await db.transaction(async (tx) => {
    await assertOwned(tx, inst, [[departments, body.departmentId]]);
    let userId: string | null = null;
    if (body.login) {
      const rs = await tx.select().from(roles).where(and(eq(roles.institutionId, inst)));
      const ids = body.login.roleKeys.map((k) => rs.find((r) => r.key === k)?.id);
      if (ids.some((x) => !x)) throw badRequest('Unknown role key');
      if (body.login.roleKeys.includes('owner') && !req.ctx!.roleKeys.includes('owner')) throw new AppError(403, 'FORBIDDEN', 'Only an owner can grant the owner role');
      userId = (await createOrAttachUser(tx, inst, { email: body.login.email, fullName: body.fullName, phone: body.phone, password: body.login.password }, ids as string[])).user.id;
    }
    const { login: _l, ...f } = body;
    const [s] = await tx.insert(staff).values({ ...f, institutionId: inst, userId }).returning();
    await auditReq(tx, req, { action: 'staff.created', entityType: 'staff', entityId: s.id, after: s });
    return s;
  });
  res.status(201).json({ data: s });
});

staffRouter.patch('/:id', requirePermission('staff.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(z.object(fields).partial(), req.body);
  const inst = req.ctx!.institutionId;
  await assertOwned(db, inst, [[departments, body.departmentId]]);
  const [before] = await db.select().from(staff).where(and(eq(staff.id, id), eq(staff.institutionId, inst), isNull(staff.deletedAt)));
  if (!before) throw notFound('Staff member');
  const [after] = await db.update(staff).set({ ...body, updatedAt: new Date() }).where(eq(staff.id, id)).returning();
  await auditReq(db, req, { action: 'staff.updated', entityType: 'staff', entityId: id, before, after });
  res.json({ data: after });
});

staffRouter.delete('/:id', requirePermission('staff.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const [s] = await db.update(staff).set({ deletedAt: new Date(), employmentStatus: 'inactive' }).where(and(eq(staff.id, id), eq(staff.institutionId, req.ctx!.institutionId), isNull(staff.deletedAt))).returning();
  if (!s) throw notFound('Staff member');
  await auditReq(db, req, { action: 'staff.deleted', entityType: 'staff', entityId: id });
  res.json({ data: { ok: true } });
});

// ---- Staff leave (separate workflow from student leave) ----
staffRouter.get('/leave/requests', requirePermission('leave.request', 'leave.review'), async (req, res) => {
  const canReview = req.ctx!.permissions.has('leave.review') && req.ctx!.permissions.has('staff.read');
  const where = and(eq(staffLeaveRequests.institutionId, req.ctx!.institutionId), canReview ? undefined : eq(staffLeaveRequests.staffId, req.ctx!.staffId ?? '00000000-0000-0000-0000-000000000000'));
  const rows = await db.select({ r: staffLeaveRequests, staffName: staff.fullName }).from(staffLeaveRequests).innerJoin(staff, eq(staff.id, staffLeaveRequests.staffId)).where(where).orderBy(sql`${staffLeaveRequests.createdAt} desc`).limit(200);
  res.json({ data: rows.map((x) => ({ ...x.r, staffName: x.staffName })) });
});

staffRouter.post('/leave/requests', requirePermission('leave.request'), async (req, res) => {
  if (!req.ctx!.staffId) throw badRequest('Only staff members can apply for staff leave');
  const body = parse(z.object({ leaveType: z.string().min(2).max(40), startDate: isoDate, endDate: isoDate, reason: z.string().trim().min(3).max(1000) }), req.body);
  if (body.startDate > body.endDate) throw badRequest('startDate must be on or before endDate');
  const [r] = await db.insert(staffLeaveRequests).values({ ...body, institutionId: req.ctx!.institutionId, staffId: req.ctx!.staffId }).returning();
  await auditReq(db, req, { action: 'staff_leave.requested', entityType: 'staff_leave', entityId: r.id, after: r });
  res.status(201).json({ data: r });
});

staffRouter.post('/leave/requests/:id/review', requirePermission('leave.review'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(500).optional() }), req.body);
  const [r] = await db.select().from(staffLeaveRequests).where(and(eq(staffLeaveRequests.id, id), eq(staffLeaveRequests.institutionId, req.ctx!.institutionId)));
  if (!r) throw notFound('Leave request');
  if (r.status !== 'pending') throw new AppError(409, 'ALREADY_REVIEWED', 'This request has already been reviewed');
  if (r.staffId === req.ctx!.staffId) throw badRequest('You cannot review your own leave request');
  const [after] = await db.update(staffLeaveRequests).set({ status: body.decision, reviewNote: body.note, reviewerUserId: req.auth!.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(staffLeaveRequests.id, id)).returning();
  await auditReq(db, req, { action: `staff_leave.${body.decision}`, entityType: 'staff_leave', entityId: id, before: r, after });
  res.json({ data: after });
});
