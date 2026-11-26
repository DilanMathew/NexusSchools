import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db, type DbOrTx } from '../../db/client.js';
import { users, refreshTokens, memberships, institutions, userRoles, roles } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { randomToken, sha256, signAccessToken } from '../../lib/security.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export async function findUserByEmail(email: string, conn: DbOrTx = db) {
  const [u] = await conn.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
  return u ?? null;
}

export async function issueTokens(userId: string, platformRole: string | null, userAgent?: string, familyId?: string) {
  const accessToken = signAccessToken({ sub: userId, pr: platformRole });
  const refresh = randomToken(48);
  const [row] = await db.insert(refreshTokens).values({
    userId, tokenHash: sha256(refresh), familyId: familyId ?? crypto.randomUUID(),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000), userAgent: userAgent?.slice(0, 300),
  }).returning({ id: refreshTokens.id });
  return { accessToken, refreshToken: refresh, refreshTokenId: row.id, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * Rotates a refresh token. Reuse of an already-rotated token revokes the whole token family
 * (likely theft), forcing re-login on every device that shares it.
 */
export async function rotateRefreshToken(raw: string, userAgent?: string) {
  const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(raw)));
  if (!row) return null;
  if (row.revokedAt) {
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
    return null;
  }
  if (row.expiresAt < new Date()) return null;
  const [u] = await db.select().from(users).where(eq(users.id, row.userId));
  if (!u || u.status !== 'active') return null;
  const next = await issueTokens(u.id, u.platformRole, userAgent, row.familyId);
  await db.update(refreshTokens).set({ revokedAt: new Date(), replacedById: next.refreshTokenId }).where(eq(refreshTokens.id, row.id));
  return { user: u, tokens: next };
}

export async function revokeRefreshToken(raw: string) {
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.tokenHash, sha256(raw)), isNull(refreshTokens.revokedAt)));
}

export async function revokeAllForUser(userId: string, conn: DbOrTx = db) {
  await conn.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())));
}

export async function listMemberships(userId: string) {
  const rows = await db.select({
    institutionId: institutions.id, name: institutions.name, slug: institutions.slug, type: institutions.type,
    status: institutions.status, logoUrl: institutions.logoUrl, primaryColor: institutions.primaryColor, isDemo: institutions.isDemo,
    roleKey: roles.key, roleName: roles.name,
  })
    .from(memberships)
    .innerJoin(institutions, eq(institutions.id, memberships.institutionId))
    .leftJoin(userRoles, eq(userRoles.membershipId, memberships.id))
    .leftJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active'), isNull(institutions.deletedAt)));
  const map = new Map<string, { institutionId: string; name: string; slug: string; type: string; status: string; logoUrl: string | null; primaryColor: string; isDemo: boolean; roles: { key: string; name: string }[] }>();
  for (const r of rows) {
    const e = map.get(r.institutionId) ?? { institutionId: r.institutionId, name: r.name, slug: r.slug, type: r.type, status: r.status, logoUrl: r.logoUrl, primaryColor: r.primaryColor, isDemo: r.isDemo, roles: [] };
    if (r.roleKey) e.roles.push({ key: r.roleKey, name: r.roleName! });
    map.set(r.institutionId, e);
  }
  return [...map.values()];
}

export function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, email: u.email, fullName: u.fullName, phone: u.phone, platformRole: u.platformRole, preferredLanguage: u.preferredLanguage };
}
