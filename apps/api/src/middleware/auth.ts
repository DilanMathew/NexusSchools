import type { NextFunction, Request, Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { institutions, memberships, rolePermissions, roles, userRoles, staff, students, guardians, users } from '../db/schema/index.js';
import { verifyAccessToken } from '../lib/security.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import type { Permission } from '../modules/rbac/catalogue.js';
import type { TenantContext } from '../types.js';

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(unauthorized());
  try {
    const claims = verifyAccessToken(header.slice(7));
    const [u] = await db.select({ id: users.id, status: users.status, platformRole: users.platformRole }).from(users).where(eq(users.id, claims.sub));
    if (!u || u.status !== 'active') return next(unauthorized('Account is not active'));
    req.auth = { userId: u.id, platformRole: u.platformRole };
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}

/** Loads the full tenant context for a (user, institution) pair from the database. */
export async function loadTenantContext(userId: string, institutionId: string): Promise<TenantContext | null> {
  const [m] = await db
    .select({ membershipId: memberships.id, status: memberships.status, instStatus: institutions.status, instType: institutions.type, tz: institutions.timezone, deletedAt: institutions.deletedAt })
    .from(memberships)
    .innerJoin(institutions, eq(institutions.id, memberships.institutionId))
    .where(and(eq(memberships.userId, userId), eq(memberships.institutionId, institutionId)));
  if (!m || m.status !== 'active' || m.deletedAt) return null;
  if (m.instStatus !== 'active') throw new AppError(403, 'INSTITUTION_SUSPENDED', 'This institution is not active. Contact the platform administrator.');

  const roleRows = await db.select({ key: roles.key, perm: rolePermissions.permissionCode })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(eq(userRoles.membershipId, m.membershipId));

  const [s] = await db.select({ id: staff.id, dept: staff.departmentId }).from(staff)
    .where(and(eq(staff.userId, userId), eq(staff.institutionId, institutionId), isNull(staff.deletedAt)));
  const [st] = await db.select({ id: students.id }).from(students)
    .where(and(eq(students.userId, userId), eq(students.institutionId, institutionId), isNull(students.deletedAt)));
  const [g] = await db.select({ id: guardians.id }).from(guardians)
    .where(and(eq(guardians.userId, userId), eq(guardians.institutionId, institutionId)));

  return {
    institutionId,
    institutionType: m.instType,
    timezone: m.tz,
    membershipId: m.membershipId,
    roleKeys: [...new Set(roleRows.map((r) => r.key))],
    permissions: new Set(roleRows.map((r) => r.perm).filter(Boolean) as Permission[]),
    staffId: s?.id ?? null,
    staffDepartmentId: s?.dept ?? null,
    studentId: st?.id ?? null,
    guardianId: g?.id ?? null,
  };
}

/**
 * Resolves the active institution from the X-Institution-Id header and verifies the caller holds an
 * active membership there. The client can *select* among its memberships but can never reach a tenant
 * it doesn't belong to.
 */
export async function tenant(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  const institutionId = req.header('x-institution-id');
  if (!institutionId || !/^[0-9a-f-]{36}$/i.test(institutionId)) return next(new AppError(400, 'TENANT_REQUIRED', 'X-Institution-Id header is required'));
  try {
    const ctx = await loadTenantContext(req.auth.userId, institutionId);
    if (!ctx) return next(forbidden('You are not a member of this institution'));
    req.ctx = ctx;
    next();
  } catch (e) { next(e); }
}

export function can(req: Request, ...anyOf: Permission[]) {
  return !!req.ctx && anyOf.some((p) => req.ctx!.permissions.has(p));
}

export const requirePermission = (...anyOf: Permission[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.ctx) return next(unauthorized());
  if (!can(req, ...anyOf)) return next(forbidden());
  next();
};

export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.platformRole !== 'super_admin') return next(forbidden('Platform administrator access required'));
  next();
}
