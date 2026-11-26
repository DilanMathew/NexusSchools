import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, eq, gt, isNull } from 'drizzle-orm';
import rateLimit from 'express-rate-limit';
import { db } from '../../db/client.js';
import { users, passwordResetTokens } from '../../db/schema/index.js';
import { parse } from '../../lib/http.js';
import { AppError, badRequest, unauthorized } from '../../lib/errors.js';
import { hashPassword, passwordProblems, randomToken, sha256, verifyPassword } from '../../lib/security.js';
import { audit } from '../../lib/audit.js';
import { authenticate, loadTenantContext } from '../../middleware/auth.js';
import { env, isProd } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { provisionInstitution } from '../institutions/provision.js';
import {
  findUserByEmail, issueTokens, listMemberships, publicUser, revokeAllForUser, revokeRefreshToken, rotateRefreshToken,
  LOCKOUT_MINUTES, MAX_FAILED_LOGINS,
} from './service.js';

export const authRouter = Router();

const REFRESH_COOKIE = 'aiq_rt';
function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true, secure: isProd, sameSite: 'strict', path: '/api/auth', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000,
  });
}

const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: env.NODE_ENV === 'test' ? 10_000 : 30, standardHeaders: true, legacyHeaders: false });

const passwordField = z.string().min(1).max(128).superRefine((v, ctx) => {
  const p = passwordProblems(v);
  if (p) ctx.addIssue({ code: 'custom', message: p });
});

const registerSchema = z.object({
  institution: z.object({
    name: z.string().trim().min(3).max(150),
    type: z.enum(['school', 'college', 'university', 'polytechnic', 'coaching', 'other']),
    timezone: z.string().max(60).optional(),
    contactPhone: z.string().max(30).optional(),
    address: z.string().max(500).optional(),
  }),
  owner: z.object({
    fullName: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(200),
    password: passwordField,
  }),
});

/** Institution self-registration: creates the owner account and a fully provisioned tenant. */
authRouter.post('/register-institution', authLimiter, async (req, res) => {
  const body = parse(registerSchema, req.body);
  if (await findUserByEmail(body.owner.email)) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Sign in to add another institution.');
  const result = await db.transaction(async (tx) => {
    const [u] = await tx.insert(users).values({ email: body.owner.email.toLowerCase(), fullName: body.owner.fullName, passwordHash: await hashPassword(body.owner.password) }).returning();
    const p = await provisionInstitution(tx, { ...body.institution, contactEmail: body.owner.email, ownerUserId: u.id });
    await audit(tx, { institutionId: p.institution.id, actorUserId: u.id, action: 'institution.registered', entityType: 'institution', entityId: p.institution.id, after: { name: p.institution.name, type: p.institution.type }, ip: req.ip });
    return { user: u, institution: p.institution };
  });
  const tokens = await issueTokens(result.user.id, null, req.headers['user-agent']);
  setRefreshCookie(res, tokens.refreshToken);
  res.status(201).json({ data: { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, user: publicUser(result.user), institutionId: result.institution.id, memberships: await listMemberships(result.user.id) } });
});

const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(128) });

authRouter.post('/login', authLimiter, async (req, res) => {
  const { email, password } = parse(loginSchema, req.body);
  const u = await findUserByEmail(email);
  const generic = new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
  if (!u) { await verifyPassword(password, '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv'); throw generic; }
  if (u.lockedUntil && u.lockedUntil > new Date()) throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again after ${LOCKOUT_MINUTES} minutes.`);
  if (u.status !== 'active') throw generic;
  if (!(await verifyPassword(password, u.passwordHash))) {
    const failed = u.failedLoginCount + 1;
    await db.update(users).set({ failedLoginCount: failed >= MAX_FAILED_LOGINS ? 0 : failed, lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null }).where(eq(users.id, u.id));
    if (failed >= MAX_FAILED_LOGINS) await audit(db, { actorUserId: u.id, action: 'auth.locked', entityType: 'user', entityId: u.id, ip: req.ip });
    throw generic;
  }
  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, u.id));
  const tokens = await issueTokens(u.id, u.platformRole, req.headers['user-agent']);
  setRefreshCookie(res, tokens.refreshToken);
  res.json({ data: { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, user: publicUser(u), memberships: await listMemberships(u.id) } });
});

authRouter.post('/refresh', async (req: Request, res) => {
  // Cookie is SameSite=Strict + path-scoped; the custom header blocks simple cross-site form posts.
  if (req.header('x-requested-with') !== 'attendiq') throw badRequest('Missing X-Requested-With header');
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!raw) throw unauthorized('No session');
  const r = await rotateRefreshToken(raw, req.headers['user-agent']);
  if (!r) { res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' }); throw unauthorized('Session expired'); }
  setRefreshCookie(res, r.tokens.refreshToken);
  res.json({ data: { accessToken: r.tokens.accessToken, expiresIn: r.tokens.expiresIn, user: publicUser(r.user), memberships: await listMemberships(r.user.id) } });
});

authRouter.post('/logout', async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (raw) await revokeRefreshToken(raw);
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  res.json({ data: { ok: true } });
});

authRouter.get('/me', authenticate, async (req, res) => {
  const [u] = await db.select().from(users).where(eq(users.id, req.auth!.userId));
  const ms = await listMemberships(u.id);
  const instId = req.header('x-institution-id');
  let context = null;
  if (instId && ms.some((m) => m.institutionId === instId)) {
    const ctx = await loadTenantContext(u.id, instId).catch(() => null);
    if (ctx) context = { institutionId: ctx.institutionId, institutionType: ctx.institutionType, timezone: ctx.timezone, roleKeys: ctx.roleKeys, permissions: [...ctx.permissions], staffId: ctx.staffId, studentId: ctx.studentId, guardianId: ctx.guardianId };
  }
  res.json({ data: { user: publicUser(u), memberships: ms, context } });
});

authRouter.post('/change-password', authenticate, async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: passwordField }), req.body);
  const [u] = await db.select().from(users).where(eq(users.id, req.auth!.userId));
  if (!(await verifyPassword(body.currentPassword, u.passwordHash))) throw new AppError(400, 'INVALID_PASSWORD', 'Current password is incorrect');
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date() }).where(eq(users.id, u.id));
    await revokeAllForUser(u.id, tx);
    await audit(tx, { actorUserId: u.id, action: 'auth.password_changed', entityType: 'user', entityId: u.id, ip: req.ip });
  });
  res.json({ data: { ok: true } });
});

authRouter.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().email() }), req.body);
  const u = await findUserByEmail(email);
  if (u && u.status === 'active') {
    const raw = randomToken(32);
    await db.insert(passwordResetTokens).values({ userId: u.id, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 30 * 60_000) });
    // No email provider is configured in this build; in development the link is written to the server log only.
    if (!isProd) logger.info({ resetUrl: `${env.CORS_ORIGIN}/reset-password?token=${raw}` }, 'Password reset link (dev only)');
  }
  // Same response whether or not the account exists (no user enumeration).
  res.json({ data: { ok: true, message: 'If an account exists for this email, a reset link has been sent.' } });
});

authRouter.post('/reset-password', authLimiter, async (req, res) => {
  const body = parse(z.object({ token: z.string().min(20), newPassword: passwordField }), req.body);
  const [row] = await db.select().from(passwordResetTokens).where(and(eq(passwordResetTokens.tokenHash, sha256(body.token)), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, new Date())));
  if (!row) throw new AppError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired');
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, row.userId));
    await tx.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, row.id));
    await revokeAllForUser(row.userId, tx);
    await audit(tx, { actorUserId: row.userId, action: 'auth.password_reset', entityType: 'user', entityId: row.userId, ip: req.ip });
  });
  res.json({ data: { ok: true } });
});
