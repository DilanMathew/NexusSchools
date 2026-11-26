import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, timestamp, boolean, integer, jsonb, pgEnum, primaryKey, uniqueIndex, index, numeric,
} from 'drizzle-orm/pg-core';

export const institutionTypeEnum = pgEnum('institution_type', ['school', 'college', 'university', 'polytechnic', 'coaching', 'other']);
export const institutionStatusEnum = pgEnum('institution_status', ['pending', 'active', 'suspended']);
export const userStatusEnum = pgEnum('user_status', ['active', 'disabled']);
export const membershipStatusEnum = pgEnum('membership_status', ['active', 'invited', 'disabled']);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['trial', 'active', 'past_due', 'expired', 'cancelled']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const institutions = pgTable('institutions', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  type: institutionTypeEnum('type').notNull(),
  status: institutionStatusEnum('status').notNull().default('active'),
  logoUrl: text('logo_url'),
  primaryColor: text('primary_color').notNull().default('#1e3a8a'),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  locale: text('locale').notNull().default('en'),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  address: text('address'),
  isDemo: boolean('is_demo').notNull().default(false),
  suspendedReason: text('suspended_reason'),
  ...timestamps,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [uniqueIndex('institutions_slug_uq').on(t.slug)]);

export const institutionBranches = pgTable('institution_branches', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  code: text('code').notNull(),
  address: text('address'),
  isMain: boolean('is_main').notNull().default(false),
  ...timestamps,
}, (t) => [uniqueIndex('branches_inst_code_uq').on(t.institutionId, t.code)]);

/** Feature toggles, terminology, notification settings. One row per institution. */
export const institutionSettings = pgTable('institution_settings', {
  institutionId: uuid('institution_id').primaryKey().references(() => institutions.id, { onDelete: 'cascade' }),
  modules: jsonb('modules').$type<Record<string, boolean>>().notNull().default({}),
  terminology: jsonb('terminology').$type<Record<string, string>>().notNull().default({}),
  notificationSettings: jsonb('notification_settings').$type<Record<string, unknown>>().notNull().default({}),
  workingDays: integer('working_days').array().notNull().default(sql`ARRAY[1,2,3,4,5,6]`),
  ...timestamps,
});

export const subscriptionPlans = pgTable('subscription_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  priceMonthlyInr: numeric('price_monthly_inr', { precision: 12, scale: 2 }),
  limits: jsonb('limits').$type<{ maxStudents?: number; maxStaff?: number; maxBranches?: number; aiRequestsPerMonth?: number }>().notNull().default({}),
  features: jsonb('features').$type<string[]>().notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
}, (t) => [uniqueIndex('plans_code_uq').on(t.code)]);

export const institutionSubscriptions = pgTable('institution_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' }),
  planId: uuid('plan_id').notNull().references(() => subscriptionPlans.id),
  status: subscriptionStatusEnum('status').notNull().default('trial'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [index('subs_inst_idx').on(t.institutionId)]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  /** 'super_admin' for NEXUS platform staff; null for institution users. */
  platformRole: text('platform_role'),
  status: userStatusEnum('status').notNull().default('active'),
  preferredLanguage: text('preferred_language').notNull().default('en'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)]);

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  familyId: uuid('family_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  replacedById: uuid('replaced_by_id'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('refresh_hash_uq').on(t.tokenHash), index('refresh_user_idx').on(t.userId)]);

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('pwreset_hash_uq').on(t.tokenHash)]);

/** institution_users: a user's membership in one institution. */
export const memberships = pgTable('institution_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: membershipStatusEnum('status').notNull().default('active'),
  ...timestamps,
}, (t) => [uniqueIndex('membership_inst_user_uq').on(t.institutionId, t.userId), index('membership_user_idx').on(t.userId)]);

/** Permission catalogue (codes defined in code, mirrored here for FK integrity). */
export const permissions = pgTable('permissions', {
  code: text('code').primaryKey(),
  module: text('module').notNull(),
  description: text('description').notNull(),
});

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  ...timestamps,
}, (t) => [uniqueIndex('roles_inst_key_uq').on(t.institutionId, t.key)]);

export const rolePermissions = pgTable('role_permissions', {
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permissionCode: text('permission_code').notNull().references(() => permissions.code, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.roleId, t.permissionCode] })]);

export const userRoles = pgTable('user_roles', {
  membershipId: uuid('membership_id').notNull().references(() => memberships.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.membershipId, t.roleId] })]);

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').references(() => institutions.id, { onDelete: 'cascade' }),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  metadata: jsonb('metadata'),
  ipAddress: text('ip_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_inst_created_idx').on(t.institutionId, t.createdAt), index('audit_entity_idx').on(t.entityType, t.entityId)]);

/** Time-bound, justified support access for platform staff to a tenant's data. */
export const supportAccessGrants = pgTable('support_access_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' }),
  platformUserId: uuid('platform_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
