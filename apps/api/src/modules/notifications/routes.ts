import { Router } from 'express';
import { z } from 'zod';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { notifications, notificationDeliveryLogs, notificationPreferences } from '../../db/schema/index.js';
import { parse, paginationSchema, pageMeta } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';

export const notificationsRouter = Router();

notificationsRouter.get('/', async (req, res) => {
  const p = parse(paginationSchema.extend({ unread: z.enum(['true', 'false']).optional() }), req.query);
  const where = and(eq(notifications.institutionId, req.ctx!.institutionId), eq(notifications.recipientUserId, req.auth!.userId), p.unread === 'true' ? isNull(notifications.readAt) : undefined);
  const [{ total }] = await db.select({ total: count() }).from(notifications).where(where);
  const [{ unread }] = await db.select({ unread: count() }).from(notifications).where(and(eq(notifications.institutionId, req.ctx!.institutionId), eq(notifications.recipientUserId, req.auth!.userId), isNull(notifications.readAt)));
  const rows = await db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({ data: rows, meta: { ...pageMeta(p, total), unread } });
});

notificationsRouter.post('/read', async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(500).optional() }), req.body);
  await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.recipientUserId, req.auth!.userId), eq(notifications.institutionId, req.ctx!.institutionId), isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined));
  res.json({ data: { ok: true } });
});

notificationsRouter.get('/preferences', async (req, res) => {
  res.json({ data: await db.select().from(notificationPreferences).where(and(eq(notificationPreferences.userId, req.auth!.userId), eq(notificationPreferences.institutionId, req.ctx!.institutionId))) });
});

notificationsRouter.put('/preferences', async (req, res) => {
  const { prefs } = parse(z.object({ prefs: z.array(z.object({ eventKey: z.string().max(60), channel: z.enum(['in_app', 'email', 'sms', 'whatsapp', 'push']), enabled: z.boolean() })).max(100) }), req.body);
  for (const pr of prefs) {
    await db.insert(notificationPreferences).values({ ...pr, userId: req.auth!.userId, institutionId: req.ctx!.institutionId })
      .onConflictDoUpdate({ target: [notificationPreferences.institutionId, notificationPreferences.userId, notificationPreferences.eventKey, notificationPreferences.channel], set: { enabled: pr.enabled } });
  }
  res.json({ data: { ok: true } });
});

/** Delivery status across channels (admin). Shows skipped channels honestly when no provider is configured. */
notificationsRouter.get('/delivery', requirePermission('notifications.manage'), async (req, res) => {
  const rows = await db.select({ channel: notificationDeliveryLogs.channel, status: notificationDeliveryLogs.status, n: sql<number>`count(*)::int` }).from(notificationDeliveryLogs)
    .where(eq(notificationDeliveryLogs.institutionId, req.ctx!.institutionId)).groupBy(notificationDeliveryLogs.channel, notificationDeliveryLogs.status);
  res.json({ data: rows });
});
