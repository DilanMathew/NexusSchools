import { Router } from 'express';
import { z } from 'zod';
import { and, count, desc, eq, sql, isNull, gte } from 'drizzle-orm';
import { db, pool } from '../../db/client.js';
import { institutions, institutionSubscriptions, subscriptionPlans, memberships, students, auditLogs, users, aiUsageLogs } from '../../db/schema/index.js';
import { parse, paginationSchema, pageMeta, uuidParam } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePlatformAdmin } from '../../middleware/auth.js';

/**
 * Platform super-admin APIs. These expose only aggregate counts and institution metadata —
 * never student-level records. Support access to tenant data requires a time-bound grant (not yet exposed).
 */
export const platformRouter = Router();
platformRouter.use(requirePlatformAdmin);

platformRouter.get('/stats', async (_req, res) => {
  const byStatus = await db.select({ status: institutions.status, n: count() }).from(institutions).where(isNull(institutions.deletedAt)).groupBy(institutions.status);
  const [{ totalStudents }] = await db.select({ totalStudents: count() }).from(students).where(isNull(students.deletedAt));
  const [{ totalUsers }] = await db.select({ totalUsers: count() }).from(users);
  const subs = await db.select({ status: institutionSubscriptions.status, plan: subscriptionPlans.code, n: count() })
    .from(institutionSubscriptions).innerJoin(subscriptionPlans, eq(subscriptionPlans.id, institutionSubscriptions.planId))
    .groupBy(institutionSubscriptions.status, subscriptionPlans.code);
  const since = new Date(Date.now() - 30 * 86400_000);
  const [ai] = await db.select({ runs: count(), tokens: sql<number>`coalesce(sum(${aiUsageLogs.inputTokens} + ${aiUsageLogs.outputTokens}),0)::int` }).from(aiUsageLogs).where(gte(aiUsageLogs.createdAt, since));
  const t0 = Date.now();
  await pool.query('select 1');
  const dbLatencyMs = Date.now() - t0;
  const { rows: [size] } = await pool.query<{ bytes: string }>('select pg_database_size(current_database())::text as bytes');
  res.json({ data: {
    institutions: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    totalInstitutions: byStatus.reduce((a, b) => a + b.n, 0),
    totalStudents, totalUsers, subscriptions: subs, ai30d: ai,
    health: { api: 'ok', dbLatencyMs, databaseBytes: Number(size.bytes), uptimeSeconds: Math.round(process.uptime()) },
  } });
});

platformRouter.get('/institutions', async (req, res) => {
  const p = parse(paginationSchema.extend({ status: z.enum(['pending', 'active', 'suspended']).optional() }), req.query);
  const where = and(isNull(institutions.deletedAt), p.status ? eq(institutions.status, p.status) : undefined, p.search ? sql`${institutions.name} ILIKE ${'%' + p.search + '%'}` : undefined);
  const [{ total }] = await db.select({ total: count() }).from(institutions).where(where);
  const rows = await db.select({
    id: institutions.id, name: institutions.name, slug: institutions.slug, type: institutions.type, status: institutions.status, isDemo: institutions.isDemo, createdAt: institutions.createdAt,
    studentCount: sql<number>`(select count(*)::int from students s where s.institution_id = "institutions"."id" and s.deleted_at is null)`,
    userCount: sql<number>`(select count(*)::int from institution_users m where m.institution_id = "institutions"."id")`,
    plan: sql<string | null>`(select p.code from institution_subscriptions s join subscription_plans p on p.id = s.plan_id where s.institution_id = "institutions"."id" order by s.created_at desc limit 1)`,
    subscriptionStatus: sql<string | null>`(select s.status from institution_subscriptions s where s.institution_id = "institutions"."id" order by s.created_at desc limit 1)`,
  }).from(institutions).where(where).orderBy(desc(institutions.createdAt)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({ data: rows, meta: pageMeta(p, total) });
});

platformRouter.patch('/institutions/:id/status', async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().min(3).max(500) }), req.body);
  const [before] = await db.select().from(institutions).where(eq(institutions.id, id));
  if (!before) throw notFound('Institution');
  const [after] = await db.update(institutions).set({ status: body.status, suspendedReason: body.status === 'suspended' ? body.reason : null, updatedAt: new Date() }).where(eq(institutions.id, id)).returning();
  await audit(db, { institutionId: id, actorUserId: req.auth!.userId, action: `platform.institution_${body.status === 'active' ? 'activated' : 'suspended'}`, entityType: 'institution', entityId: id, before: { status: before.status }, after: { status: after.status }, metadata: { reason: body.reason }, ip: req.ip });
  res.json({ data: after });
});

platformRouter.get('/plans', async (_req, res) => {
  res.json({ data: await db.select().from(subscriptionPlans).orderBy(subscriptionPlans.code) });
});

platformRouter.put('/institutions/:id/subscription', async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(z.object({ planCode: z.string(), status: z.enum(['trial', 'active', 'past_due', 'expired', 'cancelled']), endsAt: z.string().datetime().optional() }), req.body);
  const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.code, body.planCode));
  if (!plan) throw notFound('Plan');
  const [sub] = await db.insert(institutionSubscriptions).values({ institutionId: id, planId: plan.id, status: body.status, endsAt: body.endsAt ? new Date(body.endsAt) : null }).returning();
  await audit(db, { institutionId: id, actorUserId: req.auth!.userId, action: 'platform.subscription_changed', entityType: 'subscription', entityId: sub.id, after: body, ip: req.ip });
  res.json({ data: sub });
});

platformRouter.get('/audit', async (req, res) => {
  const p = parse(paginationSchema, req.query);
  const where = sql`${auditLogs.action} LIKE 'platform.%' OR ${auditLogs.action} = 'institution.registered'`;
  const [{ total }] = await db.select({ total: count() }).from(auditLogs).where(where);
  const rows = await db.select({ id: auditLogs.id, action: auditLogs.action, institutionId: auditLogs.institutionId, metadata: auditLogs.metadata, createdAt: auditLogs.createdAt, actor: users.email })
    .from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorUserId)).where(where).orderBy(desc(auditLogs.createdAt)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({ data: rows, meta: pageMeta(p, total) });
});
void memberships;
