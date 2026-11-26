import { Router } from 'express';
import { z } from 'zod';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { guardians, studentGuardians, students, roles } from '../../db/schema/index.js';
import { parse, paginationSchema, pageMeta, uuidParam } from '../../lib/http.js';
import { AppError, notFound } from '../../lib/errors.js';
import { auditReq } from '../../lib/audit.js';
import { assertOwned } from '../../lib/tenant-crud.js';
import { requirePermission } from '../../middleware/auth.js';
import { createOrAttachUser } from '../users/routes.js';

export const guardiansRouter = Router();

guardiansRouter.get('/', requirePermission('guardians.manage', 'students.contact.read'), async (req, res) => {
  const p = parse(paginationSchema, req.query);
  const where = and(eq(guardians.institutionId, req.ctx!.institutionId), p.search ? sql`(${guardians.fullName} ILIKE ${'%' + p.search + '%'} OR ${guardians.phone} ILIKE ${'%' + p.search + '%'})` : undefined);
  const [{ total }] = await db.select({ total: count() }).from(guardians).where(where);
  const rows = await db.select({
    id: guardians.id, fullName: guardians.fullName, email: guardians.email, phone: guardians.phone, hasLogin: sql<boolean>`"guardians"."user_id" is not null`,
    children: sql<{ id: string; name: string; relationship: string }[]>`coalesce((select json_agg(json_build_object('id', s.id, 'name', s.first_name || ' ' || s.last_name, 'relationship', sg.relationship)) from student_guardians sg join students s on s.id = sg.student_id where sg.guardian_id = "guardians"."id"), '[]')`,
  }).from(guardians).where(where).orderBy(asc(guardians.fullName)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({ data: rows, meta: pageMeta(p, total) });
});

const gSchema = z.object({ fullName: z.string().trim().min(2).max(120), email: z.string().email().nullable().optional(), phone: z.string().max(30).nullable().optional(), occupation: z.string().max(80).nullable().optional() });

guardiansRouter.post('/', requirePermission('guardians.manage'), async (req, res) => {
  const body = parse(gSchema.extend({ studentId: z.string().uuid().optional(), relationship: z.string().max(40).default('guardian') }), req.body);
  const inst = req.ctx!.institutionId;
  const g = await db.transaction(async (tx) => {
    const { studentId, relationship, ...fields } = body;
    const [g] = await tx.insert(guardians).values({ ...fields, institutionId: inst }).returning();
    if (studentId) {
      await assertOwned(tx, inst, [[students, studentId]]);
      await tx.insert(studentGuardians).values({ institutionId: inst, studentId, guardianId: g.id, relationship });
    }
    await auditReq(tx, req, { action: 'guardian.created', entityType: 'guardian', entityId: g.id, after: g });
    return g;
  });
  res.status(201).json({ data: g });
});

guardiansRouter.patch('/:id', requirePermission('guardians.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(gSchema.partial(), req.body);
  const [before] = await db.select().from(guardians).where(and(eq(guardians.id, id), eq(guardians.institutionId, req.ctx!.institutionId)));
  if (!before) throw notFound('Guardian');
  const [after] = await db.update(guardians).set({ ...body, updatedAt: new Date() }).where(eq(guardians.id, id)).returning();
  await auditReq(db, req, { action: 'guardian.updated', entityType: 'guardian', entityId: id, before, after });
  res.json({ data: after });
});

guardiansRouter.post('/:id/links', requirePermission('guardians.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(z.object({ studentId: z.string().uuid(), relationship: z.string().max(40).default('guardian'), isPrimary: z.boolean().default(false) }), req.body);
  const inst = req.ctx!.institutionId;
  await assertOwned(db, inst, [[guardians, id], [students, body.studentId]]);
  await db.insert(studentGuardians).values({ institutionId: inst, guardianId: id, ...body }).onConflictDoUpdate({ target: [studentGuardians.studentId, studentGuardians.guardianId], set: { relationship: body.relationship, isPrimary: body.isPrimary } });
  await auditReq(db, req, { action: 'guardian.linked', entityType: 'guardian', entityId: id, after: body });
  res.status(201).json({ data: { ok: true } });
});

guardiansRouter.delete('/:id/links/:studentId', requirePermission('guardians.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const studentId = parse(uuidParam, req.params.studentId);
  const r = await db.delete(studentGuardians).where(and(eq(studentGuardians.guardianId, id), eq(studentGuardians.studentId, studentId), eq(studentGuardians.institutionId, req.ctx!.institutionId))).returning();
  if (!r.length) throw notFound('Link');
  await auditReq(db, req, { action: 'guardian.unlinked', entityType: 'guardian', entityId: id, metadata: { studentId } });
  res.json({ data: { ok: true } });
});

guardiansRouter.post('/:id/login', requirePermission('guardians.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(128) }), req.body);
  const inst = req.ctx!.institutionId;
  const [g] = await db.select().from(guardians).where(and(eq(guardians.id, id), eq(guardians.institutionId, inst)));
  if (!g) throw notFound('Guardian');
  if (g.userId) throw new AppError(409, 'HAS_LOGIN', 'This guardian already has a login');
  await db.transaction(async (tx) => {
    const [role] = await tx.select().from(roles).where(and(eq(roles.institutionId, inst), eq(roles.key, 'parent')));
    const r = await createOrAttachUser(tx, inst, { email: body.email, fullName: g.fullName, phone: g.phone, password: body.password }, [role.id]);
    await tx.update(guardians).set({ userId: r.user.id, email: g.email ?? body.email }).where(eq(guardians.id, id));
    await auditReq(tx, req, { action: 'guardian.login_created', entityType: 'guardian', entityId: id });
  });
  res.status(201).json({ data: { ok: true } });
});
