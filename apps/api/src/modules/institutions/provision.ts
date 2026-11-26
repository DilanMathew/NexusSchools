import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import {
  institutions, institutionSettings, institutionBranches, roles, rolePermissions, memberships, userRoles,
  attendancePolicies, leaveTypes, institutionSubscriptions, subscriptionPlans,
} from '../../db/schema/index.js';
import { SYSTEM_ROLES } from '../rbac/catalogue.js';

export type InstitutionType = 'school' | 'college' | 'university' | 'polytechnic' | 'coaching' | 'other';

const isSchoolLike = (t: InstitutionType) => t === 'school' || t === 'coaching';

export function defaultModules(type: InstitutionType): Record<string, boolean> {
  const school = isSchoolLike(type);
  return {
    dailyAttendance: school,
    periodAttendance: true,
    subjectAttendance: !school,
    assemblyAttendance: type === 'school',
    labAttendance: !school,
    electives: !school,
    examEligibility: !school,
    qrAttendance: true,
    rfidAttendance: false,
    locationAttendance: false,
    offlineAttendance: true,
    parentPortal: true,
    studentPortal: true,
    campusEntry: false,
    aiInsights: true,
  };
}

export function defaultTerminology(type: InstitutionType): Record<string, string> {
  if (isSchoolLike(type)) return { classLevel: 'Class', section: 'Section', term: 'Term', department: 'Department', faculty: 'Teacher', student: 'Student' };
  return { classLevel: 'Year', section: 'Section', term: 'Semester', department: 'Department', faculty: 'Faculty', student: 'Student' };
}

export function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'institution';
}

export interface ProvisionInput {
  name: string;
  type: InstitutionType;
  slug?: string;
  timezone?: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  address?: string | null;
  ownerUserId: string;
  isDemo?: boolean;
  planCode?: string;
}

/** Creates an institution with its system roles, default policy, leave types, settings and trial. Must run in a transaction. */
export async function provisionInstitution(tx: DbOrTx, input: ProvisionInput) {
  let slug = input.slug ?? slugify(input.name);
  const existing = await tx.select({ id: institutions.id }).from(institutions).where(eq(institutions.slug, slug));
  if (existing.length) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;

  const [inst] = await tx.insert(institutions).values({
    name: input.name, type: input.type, slug, timezone: input.timezone ?? 'Asia/Kolkata',
    contactEmail: input.contactEmail ?? null, contactPhone: input.contactPhone ?? null, address: input.address ?? null,
    isDemo: input.isDemo ?? false, status: 'active',
  }).returning();

  await tx.insert(institutionSettings).values({ institutionId: inst.id, modules: defaultModules(input.type), terminology: defaultTerminology(input.type) });
  await tx.insert(institutionBranches).values({ institutionId: inst.id, name: 'Main Campus', code: 'MAIN', isMain: true });

  const roleIds: Record<string, string> = {};
  for (const tpl of SYSTEM_ROLES) {
    const [r] = await tx.insert(roles).values({ institutionId: inst.id, key: tpl.key, name: tpl.name, description: tpl.description, isSystem: true }).returning({ id: roles.id });
    roleIds[tpl.key] = r.id;
    if (tpl.permissions.length) await tx.insert(rolePermissions).values(tpl.permissions.map((p) => ({ roleId: r.id, permissionCode: p })));
  }

  const [m] = await tx.insert(memberships).values({ institutionId: inst.id, userId: input.ownerUserId }).returning({ id: memberships.id });
  await tx.insert(userRoles).values({ membershipId: m.id, roleId: roleIds.owner });

  const school = isSchoolLike(input.type);
  await tx.insert(attendancePolicies).values({
    institutionId: inst.id, name: 'Default policy', isDefault: true,
    calculationUnit: school ? 'day' : 'session',
    enabledStatuses: school ? ['present', 'absent', 'late', 'half_day', 'on_leave', 'medical_leave'] : ['present', 'absent', 'late', 'on_leave', 'medical_leave', 'on_duty'],
    separateLabAndTheory: !school,
  });

  await tx.insert(leaveTypes).values([
    { institutionId: inst.id, code: 'medical', name: 'Medical', mapsToStatus: 'medical_leave' },
    { institutionId: inst.id, code: 'personal', name: 'Personal', mapsToStatus: 'on_leave' },
    { institutionId: inst.id, code: 'family', name: 'Family', mapsToStatus: 'on_leave' },
    { institutionId: inst.id, code: 'official', name: 'Official / On duty', mapsToStatus: 'on_duty' },
    { institutionId: inst.id, code: 'other', name: 'Other', mapsToStatus: 'on_leave' },
  ]);

  const [plan] = await tx.select().from(subscriptionPlans).where(eq(subscriptionPlans.code, input.planCode ?? 'professional'));
  if (plan) {
    const trialEnds = new Date(Date.now() + 30 * 86400_000);
    await tx.insert(institutionSubscriptions).values({ institutionId: inst.id, planId: plan.id, status: 'trial', trialEndsAt: trialEnds, endsAt: trialEnds });
  }

  return { institution: inst, roleIds, ownerMembershipId: m.id };
}
