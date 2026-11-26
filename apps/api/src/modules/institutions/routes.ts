import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql, count, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  institutions, institutionSettings, institutionBranches, institutionSubscriptions, subscriptionPlans, auditLogs, users,
  students, staff,
} from '../../db/schema/index.js';
import { parse, paginationSchema, pageMeta } from '../../lib/http.js';
import { auditReq } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { provisionInstitution } from './provision.js';
import { audit } from '../../lib/audit.js';

/** Routes mounted under the tenant middleware: they always operate on req.ctx.institutionId. */
export const institutionRouter = Router();

institutionRouter.get('/current', async (req, res) => {
  const id = req.ctx!.institutionId;
  const [inst] = await db.select().from(institutions).where(eq(institutions.id, id));
  const [settings] = await db.select().from(institutionSettings).where(eq(institutionSettings.institutionId, id));
  const branches = await db.select().from(institutionBranches).where(eq(institutionBranches.institutionId, id));
  const [sub] = await db.select({ status: institutionSubscriptions.status, endsAt: institutionSubscriptions.endsAt, trialEndsAt: institutionSubscriptions.trialEndsAt, planCode: subscriptionPlans.code, planName: subscriptionPlans.name, limits: subscriptionPlans.limits, features: subscriptionPlans.features })
    .from(institutionSubscriptions).innerJoin(subscriptionPlans, eq(subscriptionPlans.id, institutionSubscriptions.planId))
    .where(eq(institutionSubscriptions.institutionId, id)).orderBy(desc(institutionSubscriptions.createdAt)).limit(1);
  res.json({ data: { ...inst, settings, branches, subscription: sub ?? null } });
});

const updateSchema = z.object({
  name: z.string().trim().min(3).max(150).optional(),
  logoUrl: z.string().url().max(500).nullable().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  timezone: z.string().max(60).optional(),
  locale: z.enum(['en', 'ta']).optional(),
  contactEmail: z.string().email().nullable().optional(),
  contactPhone: z.string().max(30).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
});

institutionRouter.patch('/current', requirePermission('institution.manage'), async (req, res) => {
  const body = parse(updateSchema, req.body);
  const id = req.ctx!.institutionId;
  const [before] = await db.select().from(institutions).where(eq(institutions.id, id));
  const [after] = await db.update(institutions).set({ ...body, updatedAt: new Date() }).where(eq(institutions.id, id)).returning();
  await auditReq(db, req, { action: 'institution.updated', entityType: 'institution', entityId: id, before, after });
  res.json({ data: after });
});

const settingsSchema = z.object({
  modules: z.record(z.string(), z.boolean()).optional(),
  terminology: z.record(z.string(), z.string().max(40)).optional(),
  notificationSettings: z.record(z.string(), z.unknown()).optional(),
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
});

institutionRouter.patch('/current/settings', requirePermission('institution.manage'), async (req, res) => {
  const body = parse(settingsSchema, req.body);
  const id = req.ctx!.institutionId;
  const [before] = await db.select().from(institutionSettings).where(eq(institutionSettings.institutionId, id));
  const [after] = await db.update(institutionSettings).set({
    ...(body.modules && { modules: { ...before.modules, ...body.modules } }),
    ...(body.terminology && { terminology: { ...before.terminology, ...body.terminology } }),
    ...(body.notificationSettings && { notificationSettings: { ...before.notificationSettings, ...body.notificationSettings } }),
    ...(body.workingDays && { workingDays: [...new Set(body.workingDays)].sort() }),
    updatedAt: new Date(),
  }).where(eq(institutionSettings.institutionId, id)).returning();
  await auditReq(db, req, { action: 'institution.settings_updated', entityType: 'institution_settings', entityId: id, before, after });
  res.json({ data: after });
});

const branchSchema = z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().min(1).max(20).toUpperCase(), address: z.string().max(500).optional() });
institutionRouter.post('/current/branches', requirePermission('institution.manage'), async (req, res) => {
  const body = parse(branchSchema, req.body);
  const [b] = await db.insert(institutionBranches).values({ ...body, institutionId: req.ctx!.institutionId }).returning();
  await auditReq(db, req, { action: 'branch.created', entityType: 'branch', entityId: b.id, after: b });
  res.status(201).json({ data: b });
});

/** Additional institution for an already-authenticated user (e.g. a trust running several schools). */
export const createInstitutionForUser = Router();
createInstitutionForUser.post('/', async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(3).max(150), type: z.enum(['school', 'college', 'university', 'polytechnic', 'coaching', 'other']), timezone: z.string().optional() }), req.body);
  const [u] = await db.select().from(users).where(eq(users.id, req.auth!.userId));
  const out = await db.transaction(async (tx) => {
    const p = await provisionInstitution(tx, { ...body, contactEmail: u.email, ownerUserId: u.id });
    await audit(tx, { institutionId: p.institution.id, actorUserId: u.id, action: 'institution.registered', entityType: 'institution', entityId: p.institution.id, after: { name: p.institution.name }, ip: req.ip });
    return p.institution;
  });
  res.status(201).json({ data: out });
});

institutionRouter.get('/current/audit', requirePermission('audit.read'), async (req, res) => {
  const p = parse(paginationSchema.extend({ entityType: z.string().max(50).optional(), action: z.string().max(80).optional() }), req.query);
  const where = and(
    eq(auditLogs.institutionId, req.ctx!.institutionId),
    p.entityType ? eq(auditLogs.entityType, p.entityType) : undefined,
    p.action ? sql`${auditLogs.action} ILIKE ${p.action + '%'}` : undefined,
  );
  const [{ total }] = await db.select({ total: count() }).from(auditLogs).where(where);
  const rows = await db.select({ id: auditLogs.id, action: auditLogs.action, entityType: auditLogs.entityType, entityId: auditLogs.entityId, before: auditLogs.before, after: auditLogs.after, metadata: auditLogs.metadata, createdAt: auditLogs.createdAt, actorName: users.fullName, actorEmail: users.email })
    .from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorUserId)).where(where)
    .orderBy(desc(auditLogs.createdAt)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({ data: rows, meta: pageMeta(p, total) });
});

/** Data export: a JSON bundle of the tenant's core records (no password hashes or tokens). */
institutionRouter.get('/current/export', requirePermission('institution.manage'), async (req, res) => {
  const id = req.ctx!.institutionId;
  const [inst] = await db.select().from(institutions).where(eq(institutions.id, id));
  const st = await db.select().from(students).where(and(eq(students.institutionId, id), isNull(students.deletedAt)));
  const sf = await db.select().from(staff).where(and(eq(staff.institutionId, id), isNull(staff.deletedAt)));
  await auditReq(db, req, { action: 'institution.exported', entityType: 'institution', entityId: id, metadata: { students: st.length, staff: sf.length } });
  res.setHeader('Content-Disposition', `attachment; filename="${inst.slug}-export.json"`);
  res.json({ exportedAt: new Date().toISOString(), institution: inst, students: st, staff: sf });
});
