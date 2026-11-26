import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { announcements, announcementReads, users } from '../../db/schema/index.js';
import { parse, uuidParam } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { auditReq } from '../../lib/audit.js';
import { requirePermission } from '../../middleware/auth.js';

export const announcementsRouter = Router();

function audienceOf(roleKeys: string[]) {
  const a = new Set<string>();
  if (roleKeys.includes('student')) a.add('students');
  if (roleKeys.includes('parent')) a.add('guardians');
  if (roleKeys.some((k) => !['student', 'parent'].includes(k))) a.add('staff');
  return [...a];
}

announcementsRouter.get('/', async (req, res) => {
  const ctx = req.ctx!;
  const manage = ctx.permissions.has('announcements.manage');
  const aud = audienceOf(ctx.roleKeys);
  const now = new Date();
  const rows = await db.select({ a: announcements, author: users.fullName, read: sql<boolean>`exists(select 1 from announcement_reads r where r.announcement_id = ${announcements.id} and r.user_id = ${req.auth!.userId})` })
    .from(announcements).leftJoin(users, eq(users.id, announcements.createdByUserId))
    .where(and(eq(announcements.institutionId, ctx.institutionId),
      manage ? undefined : and(lte(announcements.publishAt, now), or(isNull(announcements.expiresAt), gt(announcements.expiresAt, now)), aud.length ? sql`${announcements.audience} && ARRAY[${sql.join(aud.map((x) => sql`${x}`), sql`, `)}]::text[]` : sql`false`)))
    .orderBy(desc(announcements.publishAt)).limit(100);
  res.json({ data: rows.map((r) => ({ ...r.a, author: r.author, read: r.read })) });
});

const schema = z.object({
  title: z.string().trim().min(3).max(150), body: z.string().trim().min(3).max(5000),
  audience: z.array(z.enum(['students', 'guardians', 'staff'])).min(1),
  publishAt: z.string().datetime().optional(), expiresAt: z.string().datetime().nullable().optional(),
});

announcementsRouter.post('/', requirePermission('announcements.manage'), async (req, res) => {
  const body = parse(schema, req.body);
  const [a] = await db.insert(announcements).values({ ...body, publishAt: body.publishAt ? new Date(body.publishAt) : new Date(), expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, institutionId: req.ctx!.institutionId, createdByUserId: req.auth!.userId }).returning();
  await auditReq(db, req, { action: 'announcement.created', entityType: 'announcement', entityId: a.id, after: a });
  res.status(201).json({ data: a });
});

announcementsRouter.delete('/:id', requirePermission('announcements.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const [a] = await db.delete(announcements).where(and(eq(announcements.id, id), eq(announcements.institutionId, req.ctx!.institutionId))).returning();
  if (!a) throw notFound('Announcement');
  await auditReq(db, req, { action: 'announcement.deleted', entityType: 'announcement', entityId: id, before: a });
  res.json({ data: { ok: true } });
});

announcementsRouter.post('/:id/read', async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const [a] = await db.select({ id: announcements.id }).from(announcements).where(and(eq(announcements.id, id), eq(announcements.institutionId, req.ctx!.institutionId)));
  if (!a) throw notFound('Announcement');
  await db.insert(announcementReads).values({ announcementId: id, userId: req.auth!.userId }).onConflictDoNothing();
  res.json({ data: { ok: true } });
});
