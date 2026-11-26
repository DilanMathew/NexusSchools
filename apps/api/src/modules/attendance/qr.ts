import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import rateLimit from 'express-rate-limit';
import { and, count, countDistinct, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { qrSessions, qrScanEvents, attendanceRecords, attendanceSessions } from '../../db/schema/index.js';
import { parse, uuidParam } from '../../lib/http.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { auditReq } from '../../lib/audit.js';
import { requirePermission } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { assertCanTake, getRoster, getSession } from './service.js';
import { hashIp, isFresh, makeQrToken, parseQrToken } from './qr-token.js';

export const qrPublicRouter = Router();

qrPublicRouter.post('/sessions', requirePermission('attendance.take', 'attendance.take.any'), async (req, res) => {
  const ctx = req.ctx!;
  const body = parse(z.object({ attendanceSessionId: z.string().uuid(), rotationSeconds: z.number().int().min(5).max(120).default(15), durationMinutes: z.number().int().min(1).max(60).default(10) }), req.body);
  const s = await getSession(ctx.institutionId, body.attendanceSessionId);
  await assertCanTake(ctx, s);
  if (s.status !== 'open') throw new AppError(409, 'SESSION_NOT_OPEN', 'QR attendance can only run while the session is open');
  // Close any previous QR window for this session.
  await db.update(qrSessions).set({ closedAt: new Date() }).where(and(eq(qrSessions.attendanceSessionId, s.id), sql`${qrSessions.closedAt} is null`));
  const [q] = await db.insert(qrSessions).values({ institutionId: ctx.institutionId, attendanceSessionId: s.id, createdByUserId: req.auth!.userId, rotationSeconds: body.rotationSeconds, expiresAt: new Date(Date.now() + body.durationMinutes * 60_000) }).returning();
  await auditReq(db, req, { action: 'qr_session.started', entityType: 'qr_session', entityId: q.id, metadata: { attendanceSessionId: s.id } });
  res.status(201).json({ data: q });
});

async function loadQr(inst: string, id: string) {
  const [q] = await db.select().from(qrSessions).where(and(eq(qrSessions.id, id), eq(qrSessions.institutionId, inst)));
  if (!q) throw notFound('QR session');
  return q;
}

/** Teacher display polls this: returns the current rotating token as a QR image plus live progress. */
qrPublicRouter.get('/sessions/:id/token', requirePermission('attendance.take', 'attendance.take.any'), async (req, res) => {
  const ctx = req.ctx!;
  const q = await loadQr(ctx.institutionId, parse(uuidParam, req.params.id));
  const s = await getSession(ctx.institutionId, q.attendanceSessionId);
  await assertCanTake(ctx, s);
  const active = !q.closedAt && q.expiresAt > new Date() && s.status === 'open';
  const roster = await getRoster(db, s);
  const [{ scanned }] = await db.select({ scanned: count() }).from(attendanceRecords).where(and(eq(attendanceRecords.sessionId, s.id), eq(attendanceRecords.method, 'qr')));
  const flags = await db.select({ ipHash: qrScanEvents.ipHash, n: countDistinct(qrScanEvents.studentId) }).from(qrScanEvents)
    .where(and(eq(qrScanEvents.qrSessionId, q.id), eq(qrScanEvents.outcome, 'recorded'))).groupBy(qrScanEvents.ipHash).having(sql`count(distinct ${qrScanEvents.studentId}) > 3`);
  if (!active) return res.json({ data: { active: false, closedAt: q.closedAt, expiresAt: q.expiresAt, progress: { scanned, roster: roster.length }, suspicious: flags.length } });
  const t = makeQrToken(q.id, q.rotationSeconds);
  const url = `${env.CORS_ORIGIN.split(',')[0]}/scan?t=${encodeURIComponent(t.token)}&i=${ctx.institutionId}`;
  res.json({ data: { active: true, token: t.token, url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 360 }), secondsLeft: t.secondsLeft, rotationSeconds: q.rotationSeconds, expiresAt: q.expiresAt, progress: { scanned, roster: roster.length }, suspicious: flags.length } });
});

qrPublicRouter.post('/sessions/:id/close', requirePermission('attendance.take', 'attendance.take.any'), async (req, res) => {
  const ctx = req.ctx!;
  const q = await loadQr(ctx.institutionId, parse(uuidParam, req.params.id));
  await assertCanTake(ctx, await getSession(ctx.institutionId, q.attendanceSessionId));
  await db.update(qrSessions).set({ closedAt: new Date() }).where(eq(qrSessions.id, q.id));
  res.json({ data: { ok: true } });
});

const scanLimiter = rateLimit({ windowMs: 60_000, limit: env.NODE_ENV === 'test' ? 1000 : 10, keyGenerator: (req) => req.auth?.userId ?? 'anon', standardHeaders: true, legacyHeaders: false });

/**
 * Student scan. Binds the mark to the authenticated student account; duplicate scans are no-ops.
 * A scan is evidence, not proof of presence: the teacher still reviews and submits.
 */
qrPublicRouter.post('/scan', requirePermission('attendance.self.read'), scanLimiter, async (req, res) => {
  const ctx = req.ctx!;
  const { token } = parse(z.object({ token: z.string().min(10).max(300) }), req.body);
  const log = (qrSessionId: string, outcome: string) => db.insert(qrScanEvents).values({ institutionId: ctx.institutionId, qrSessionId, studentId: ctx.studentId, userId: req.auth!.userId, outcome, userAgent: req.headers['user-agent']?.slice(0, 200) ?? null, ipHash: hashIp(req.ip) });
  const p = parseQrToken(token);
  if (!p.ok) throw badRequest('This QR code is not valid');
  if (!ctx.studentId) throw new AppError(403, 'NOT_STUDENT', 'Only student accounts can scan attendance codes');
  const [q] = await db.select().from(qrSessions).where(and(eq(qrSessions.id, p.qrSessionId), eq(qrSessions.institutionId, ctx.institutionId)));
  if (!q) throw badRequest('This QR code is not valid for your institution');
  if (q.closedAt || q.expiresAt < new Date()) { await log(q.id, 'closed'); throw new AppError(410, 'QR_CLOSED', 'This attendance window has closed'); }
  if (!isFresh(p.window, q.rotationSeconds)) { await log(q.id, 'stale_token'); throw new AppError(410, 'QR_EXPIRED', 'This code has expired. Scan the code currently on screen.'); }
  const s = await getSession(ctx.institutionId, q.attendanceSessionId);
  if (s.status !== 'open') { await log(q.id, 'session_closed'); throw new AppError(410, 'QR_CLOSED', 'Attendance for this class has been submitted'); }
  const roster = await getRoster(db, s);
  if (!roster.some((r) => r.id === ctx.studentId)) { await log(q.id, 'not_in_roster'); throw new AppError(403, 'NOT_IN_ROSTER', 'You are not on the roster for this class'); }
  const [existing] = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.sessionId, s.id), eq(attendanceRecords.studentId, ctx.studentId)));
  if (existing && (existing.method === 'qr' || existing.status === 'present')) { await log(q.id, 'duplicate'); return res.json({ data: { status: 'already_recorded' } }); }
  if (existing && existing.method === 'manual') { await log(q.id, 'teacher_marked'); return res.json({ data: { status: 'teacher_marked', message: 'Your teacher has already marked you for this class.' } }); }
  await db.insert(attendanceRecords).values({ institutionId: ctx.institutionId, sessionId: s.id, studentId: ctx.studentId, status: 'present', method: 'qr', markedByUserId: req.auth!.userId }).onConflictDoNothing();
  await log(q.id, 'recorded');
  res.json({ data: { status: 'recorded', sessionDate: s.sessionDate } });
});
void attendanceSessions;
