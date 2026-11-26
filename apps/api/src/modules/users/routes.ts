import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { memberships, users, roles, userRoles, rolePermissions, permissions } from '../../db/schema/index.js';
import { parse, paginationSchema, pageMeta, uuidParam } from '../../lib/http.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { hashPassword, passwordProblems } from '../../lib/security.js';
import { auditReq } from '../../lib/audit.js';
import { requirePermission } from '../../middleware/auth.js';
import { findUserByEmail, revokeAllForUser } from '../auth/service.js';
import { ALL_PERMISSIONS, type Permission } from '../rbac/catalogue.js';

export const usersRouter = Router();
export const rolesRouter = Router();

/** Prevents privilege escalation: a caller may only grant roles whose permissions they themselves hold. */
async function assertCanGrantRoles(req: Request, roleIds: string[], conn: DbOrTx = db) {
  if (!roleIds.length) return [];
  const rs = await conn.select().from(roles).where(and(eq(roles.institutionId, req.ctx!.institutionId), inArray(roles.id, roleIds)));
  if (rs.length !== new Set(roleIds).size) throw badRequest('One or more roles do not exist in this institution');
  const isOwner = req.ctx!.roleKeys.includes('owner');
  if (rs.some((r) => r.key === 'owner') && !isOwner) throw forbidden('Only an institution owner can grant the owner role');
  if (!isOwner) {
    const perms = await conn.select({ p: rolePermissions.permissionCode }).from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
    const missing = perms.map((x) => x.p as Permission).filter((p) => !req.ctx!.permissions.has(p));
    if (missing.length) throw forbidden(`You cannot grant permissions you do not hold: ${[...new Set(missing)].join(', ')}`);
  }
  return rs;
}

export async function createOrAttachUser(conn: DbOrTx, institutionId: string, input: { email: string; fullName: string; phone?: string | null; password?: string }, roleIds: string[]) {
  let u = await findUserByEmail(input.email, conn);
  if (!u) {
    const pw = input.password;
    if (!pw) throw badRequest('A password is required for a new account');
    const prob = passwordProblems(pw);
    if (prob) throw badRequest(prob);
    [u] = await conn.insert(users).values({ email: input.email.toLowerCase(), fullName: input.fullName, phone: input.phone ?? null, passwordHash: await hashPassword(pw) }).returning();
  }
  let [m] = await conn.select().from(memberships).where(and(eq(memberships.institutionId, institutionId), eq(memberships.userId, u.id)));
  if (!m) [m] = await conn.insert(memberships).values({ institutionId, userId: u.id }).returning();
  if (roleIds.length) await conn.insert(userRoles).values(roleIds.map((roleId) => ({ membershipId: m.id, roleId }))).onConflictDoNothing();
  return { user: u, membership: m };
}

usersRouter.get('/', requirePermission('users.read'), async (req, res) => {
  const p = parse(paginationSchema.extend({ role: z.string().max(40).optional() }), req.query);
  const inst = req.ctx!.institutionId;
  const where = and(
    eq(memberships.institutionId, inst),
    p.search ? sql`(${users.fullName} ILIKE ${'%' + p.search + '%'} OR ${users.email} ILIKE ${'%' + p.search + '%'})` : undefined,
    p.role ? sql`EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.membership_id = ${memberships.id} AND r.key = ${p.role})` : undefined,
  );
  const [{ total }] = await db.select({ total: count() }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(where);
  const rows = await db.select({ membershipId: memberships.id, status: memberships.status, userId: users.id, email: users.email, fullName: users.fullName, phone: users.phone, lastLoginAt: users.lastLoginAt })
    .from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(where)
    .orderBy(asc(users.fullName)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  const rr = rows.length ? await db.select({ membershipId: userRoles.membershipId, id: roles.id, key: roles.key, name: roles.name }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(inArray(userRoles.membershipId, rows.map((r) => r.membershipId))) : [];
  res.json({ data: rows.map((r) => ({ ...r, roles: rr.filter((x) => x.membershipId === r.membershipId).map(({ id, key, name }) => ({ id, key, name })) })), meta: pageMeta(p, total) });
});

const createSchema = z.object({
  email: z.string().trim().email().max(200),
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().max(30).optional(),
  password: z.string().max(128).optional(),
  roleIds: z.array(z.string().uuid()).min(1),
});

usersRouter.post('/', requirePermission('users.manage'), async (req, res) => {
  const body = parse(createSchema, req.body);
  const out = await db.transaction(async (tx) => {
    await assertCanGrantRoles(req, body.roleIds, tx);
    const r = await createOrAttachUser(tx, req.ctx!.institutionId, body, body.roleIds);
    await auditReq(tx, req, { action: 'user.added', entityType: 'membership', entityId: r.membership.id, after: { email: r.user.email, roleIds: body.roleIds } });
    return r;
  });
  res.status(201).json({ data: { membershipId: out.membership.id, userId: out.user.id, email: out.user.email, fullName: out.user.fullName } });
});

usersRouter.patch('/:membershipId', requirePermission('users.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.membershipId);
  const body = parse(z.object({ status: z.enum(['active', 'disabled']).optional(), roleIds: z.array(z.string().uuid()).optional() }), req.body);
  const [m] = await db.select().from(memberships).where(and(eq(memberships.id, id), eq(memberships.institutionId, req.ctx!.institutionId)));
  if (!m) throw notFound('User');
  if (m.id === req.ctx!.membershipId && (body.status === 'disabled' || body.roleIds)) throw badRequest('You cannot change your own status or roles');
  const targetRoles = await db.select({ key: roles.key }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.membershipId, m.id));
  if (targetRoles.some((r) => r.key === 'owner') && !req.ctx!.roleKeys.includes('owner')) throw forbidden('Only an owner can modify another owner');
  await db.transaction(async (tx) => {
    if (body.status) {
      await tx.update(memberships).set({ status: body.status, updatedAt: new Date() }).where(eq(memberships.id, m.id));
      if (body.status === 'disabled') await revokeAllForUser(m.userId, tx);
    }
    if (body.roleIds) {
      await assertCanGrantRoles(req, body.roleIds, tx);
      await tx.delete(userRoles).where(eq(userRoles.membershipId, m.id));
      if (body.roleIds.length) await tx.insert(userRoles).values(body.roleIds.map((roleId) => ({ membershipId: m.id, roleId })));
    }
    await auditReq(tx, req, { action: 'user.updated', entityType: 'membership', entityId: m.id, before: { status: m.status, roles: targetRoles }, after: body });
  });
  res.json({ data: { ok: true } });
});

/** Admin-initiated password reset to a temporary password (shown once to the admin). */
usersRouter.post('/:membershipId/reset-password', requirePermission('users.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.membershipId);
  const { password } = parse(z.object({ password: z.string().min(1).max(128) }), req.body);
  const prob = passwordProblems(password);
  if (prob) throw badRequest(prob);
  const [m] = await db.select().from(memberships).where(and(eq(memberships.id, id), eq(memberships.institutionId, req.ctx!.institutionId)));
  if (!m) throw notFound('User');
  // A user who belongs to other institutions controls their own credentials.
  const [{ n }] = await db.select({ n: count() }).from(memberships).where(eq(memberships.userId, m.userId));
  if (n > 1) throw new AppError(409, 'SHARED_ACCOUNT', 'This account belongs to several institutions; ask the user to use "Forgot password".');
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: await hashPassword(password), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, m.userId));
    await revokeAllForUser(m.userId, tx);
    await auditReq(tx, req, { action: 'user.password_reset_by_admin', entityType: 'membership', entityId: m.id });
  });
  res.json({ data: { ok: true } });
});

// ---------------- Roles ----------------
rolesRouter.get('/permissions', requirePermission('roles.read', 'roles.manage'), async (_req, res) => {
  res.json({ data: await db.select().from(permissions).orderBy(asc(permissions.module), asc(permissions.code)) });
});

rolesRouter.get('/', requirePermission('roles.read', 'roles.manage', 'users.manage'), async (req, res) => {
  const rs = await db.select().from(roles).where(eq(roles.institutionId, req.ctx!.institutionId)).orderBy(asc(roles.isSystem), asc(roles.name));
  const ps = rs.length ? await db.select().from(rolePermissions).where(inArray(rolePermissions.roleId, rs.map((r) => r.id))) : [];
  const counts = await db.select({ roleId: userRoles.roleId, n: count() }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(roles.institutionId, req.ctx!.institutionId)).groupBy(userRoles.roleId);
  res.json({ data: rs.map((r) => ({ ...r, permissions: ps.filter((p) => p.roleId === r.id).map((p) => p.permissionCode), memberCount: counts.find((c) => c.roleId === r.id)?.n ?? 0 })) });
});

const roleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().max(300).optional(),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]])).max(ALL_PERMISSIONS.length),
});

function assertHoldsAll(req: Request, perms: Permission[]) {
  if (req.ctx!.roleKeys.includes('owner')) return;
  const missing = perms.filter((p) => !req.ctx!.permissions.has(p));
  if (missing.length) throw forbidden(`You cannot grant permissions you do not hold: ${missing.join(', ')}`);
}

rolesRouter.post('/', requirePermission('roles.manage'), async (req, res) => {
  const body = parse(roleSchema, req.body);
  assertHoldsAll(req, body.permissions);
  const key = 'custom_' + body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40) + '_' + Math.random().toString(36).slice(2, 6);
  const role = await db.transaction(async (tx) => {
    const [r] = await tx.insert(roles).values({ institutionId: req.ctx!.institutionId, key, name: body.name, description: body.description, isSystem: false }).returning();
    if (body.permissions.length) await tx.insert(rolePermissions).values(body.permissions.map((p) => ({ roleId: r.id, permissionCode: p })));
    await auditReq(tx, req, { action: 'role.created', entityType: 'role', entityId: r.id, after: body });
    return r;
  });
  res.status(201).json({ data: role });
});

rolesRouter.put('/:id', requirePermission('roles.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(roleSchema, req.body);
  const [r] = await db.select().from(roles).where(and(eq(roles.id, id), eq(roles.institutionId, req.ctx!.institutionId)));
  if (!r) throw notFound('Role');
  if (r.key === 'owner') throw forbidden('The owner role cannot be edited');
  assertHoldsAll(req, body.permissions);
  const before = await db.select({ p: rolePermissions.permissionCode }).from(rolePermissions).where(eq(rolePermissions.roleId, id));
  await db.transaction(async (tx) => {
    await tx.update(roles).set({ name: body.name, description: body.description, updatedAt: new Date() }).where(eq(roles.id, id));
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
    if (body.permissions.length) await tx.insert(rolePermissions).values(body.permissions.map((p) => ({ roleId: id, permissionCode: p })));
    await auditReq(tx, req, { action: 'role.updated', entityType: 'role', entityId: id, before: { name: r.name, permissions: before.map((x) => x.p) }, after: body });
  });
  res.json({ data: { ok: true } });
});

rolesRouter.delete('/:id', requirePermission('roles.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const [r] = await db.select().from(roles).where(and(eq(roles.id, id), eq(roles.institutionId, req.ctx!.institutionId)));
  if (!r) throw notFound('Role');
  if (r.isSystem) throw badRequest('System roles cannot be deleted');
  const [{ n }] = await db.select({ n: count() }).from(userRoles).where(eq(userRoles.roleId, id));
  if (n > 0) throw new AppError(409, 'ROLE_IN_USE', `This role is assigned to ${n} user(s). Reassign them first.`);
  await db.delete(roles).where(eq(roles.id, id));
  await auditReq(db, req, { action: 'role.deleted', entityType: 'role', entityId: id, before: r });
  res.json({ data: { ok: true } });
});
