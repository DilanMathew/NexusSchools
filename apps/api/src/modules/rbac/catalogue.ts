import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { permissions } from '../../db/schema/index.js';

/** Single source of truth for permission codes. Enforced server-side by `requirePermission`. */
export const PERMISSIONS = {
  'institution.read': ['institution', 'View institution profile and settings'],
  'institution.manage': ['institution', 'Edit institution profile, branding, branches and settings'],
  'subscription.manage': ['institution', 'Manage subscription and billing'],
  'users.read': ['users', 'View institution user accounts'],
  'users.manage': ['users', 'Create, disable and assign roles to user accounts'],
  'roles.read': ['users', 'View roles and permissions'],
  'roles.manage': ['users', 'Create and edit custom roles'],
  'audit.read': ['audit', 'View the institution audit log'],
  'academic.read': ['academic', 'View academic structure'],
  'academic.manage': ['academic', 'Manage academic years, departments, classes, sections, subjects and offerings'],
  'calendar.manage': ['academic', 'Manage the academic calendar and holidays'],
  'students.read': ['students', 'View student records'],
  'students.manage': ['students', 'Create, edit, transfer and promote students'],
  'students.import': ['students', 'Bulk import students'],
  'students.contact.read': ['students', 'View student and guardian contact details'],
  'students.medical.read': ['students', 'View restricted medical/emergency notes'],
  'guardians.manage': ['students', 'Manage guardians and student-guardian links'],
  'staff.read': ['staff', 'View staff records'],
  'staff.manage': ['staff', 'Create and edit staff records'],
  'timetable.read': ['timetable', 'View timetables'],
  'timetable.manage': ['timetable', 'Edit timetables'],
  'attendance.take': ['attendance', 'Take attendance for assigned classes'],
  'attendance.take.any': ['attendance', 'Take attendance for any class'],
  'attendance.read': ['attendance', 'View attendance institution-wide'],
  'attendance.read.department': ['attendance', 'View attendance for own department'],
  'attendance.read.assigned': ['attendance', 'View attendance for assigned classes'],
  'attendance.correct': ['attendance', 'Directly correct submitted attendance (audited)'],
  'attendance.corrections.review': ['attendance', 'Review attendance correction requests'],
  'attendance.policy.manage': ['attendance', 'Configure attendance calculation policies'],
  'attendance.self.read': ['attendance', 'View own attendance (students)'],
  'attendance.child.read': ['attendance', "View linked children's attendance (guardians)"],
  'attendance.correction.request': ['attendance', 'Raise attendance correction requests'],
  'attendance.entry': ['attendance', 'Record campus entry/exit events'],
  'leave.request': ['leave', 'Submit leave requests'],
  'leave.review': ['leave', 'Approve or reject leave requests'],
  'reports.read': ['reports', 'View and export reports'],
  'analytics.read': ['reports', 'View institution analytics dashboards'],
  'announcements.manage': ['communication', 'Publish announcements'],
  'notifications.manage': ['communication', 'Manage notification templates and settings'],
  'ai.use': ['ai', 'Use the AI administrative assistant'],
  'ai.risk.read': ['ai', 'View attendance risk indicators'],
  'devices.manage': ['devices', 'Register and manage attendance devices and ID cards'],
  'campus.read': ['devices', 'View campus entry/exit and visitor logs'],
  'exams.manage': ['exams', 'Set up examinations, compute attendance eligibility and record exemptions'],
  'exams.confirm': ['exams', 'Record the official examination eligibility decision'],
} as const satisfies Record<string, readonly [string, string]>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const ALL_BUT = (...exclude: Permission[]) => ALL_PERMISSIONS.filter((p) => !exclude.includes(p));
const SELF_SERVICE: Permission[] = [];

export interface SystemRoleTemplate { key: string; name: string; description: string; permissions: Permission[] }

export const SYSTEM_ROLES: SystemRoleTemplate[] = [
  { key: 'owner', name: 'Institution Owner', description: 'Full control of the institution', permissions: ALL_BUT('attendance.self.read', 'attendance.child.read', 'attendance.correction.request') },
  { key: 'admin', name: 'Institution Administrator', description: 'Manages students, staff, academics and attendance', permissions: ALL_BUT('subscription.manage', 'attendance.self.read', 'attendance.child.read', 'attendance.correction.request') },
  { key: 'principal', name: 'Principal / Head of Institution', description: 'Oversight of attendance and reports', permissions: ['institution.read', 'academic.read', 'students.read', 'students.contact.read', 'staff.read', 'timetable.read', 'attendance.read', 'attendance.corrections.review', 'attendance.correct', 'leave.review', 'reports.read', 'analytics.read', 'announcements.manage', 'ai.use', 'ai.risk.read', 'audit.read', 'exams.manage', 'exams.confirm', 'campus.read'] },
  { key: 'hod', name: 'Head of Department', description: 'Departmental attendance oversight', permissions: ['institution.read', 'academic.read', 'students.read', 'staff.read', 'timetable.read', 'attendance.take', 'attendance.read.department', 'attendance.read.assigned', 'attendance.corrections.review', 'leave.review', 'leave.request', 'reports.read', 'analytics.read', 'ai.risk.read', 'announcements.manage'] },
  { key: 'class_teacher', name: 'Class Teacher / Coordinator', description: 'Takes and reviews attendance for assigned classes', permissions: ['institution.read', 'academic.read', 'students.read', 'students.contact.read', 'timetable.read', 'attendance.take', 'attendance.read.assigned', 'attendance.corrections.review', 'leave.review', 'leave.request', 'reports.read', 'announcements.manage', 'ai.risk.read'] },
  { key: 'faculty', name: 'Faculty / Lecturer', description: 'Takes attendance for assigned subjects', permissions: ['institution.read', 'academic.read', 'students.read', 'timetable.read', 'attendance.take', 'attendance.read.assigned', 'leave.request', 'reports.read'] },
  { key: 'attendance_operator', name: 'Attendance Operator', description: 'Records campus entry and operates devices', permissions: ['institution.read', 'attendance.entry', 'students.read', 'campus.read'] },
  { key: 'accountant', name: 'Accountant / Finance', description: 'Manages subscription and billing', permissions: ['institution.read', 'subscription.manage'] },
  { key: 'student', name: 'Student', description: 'Views own attendance', permissions: [...SELF_SERVICE, 'attendance.self.read', 'attendance.correction.request', 'leave.request', 'timetable.read'] },
  { key: 'parent', name: 'Parent / Guardian', description: "Views linked children's attendance", permissions: [...SELF_SERVICE, 'attendance.child.read', 'leave.request'] },
];

/** Additively grants newly-added template permissions to existing system roles (never removes institution edits). */
export async function syncSystemRolePermissions(db: DbOrTx) {
  for (const tpl of SYSTEM_ROLES) {
    if (!tpl.permissions.length) continue;
    await db.execute(sql`
      insert into role_permissions (role_id, permission_code)
      select r.id, p.code from roles r cross join unnest(${sql.raw(`ARRAY[${tpl.permissions.map((x) => `'${x}'`).join(',')}]::text[]`)}) as p(code)
      where r.key = ${tpl.key} and r.is_system = true
        and not exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_code = p.code)
        and not exists (select 1 from audit_logs a where a.institution_id = r.institution_id and a.entity_type = 'role' and a.entity_id = r.id::text and a.action = 'role.updated')`);
  }
}

export async function syncPermissionCatalogue(db: DbOrTx) {
  const rows = Object.entries(PERMISSIONS).map(([code, [module, description]]) => ({ code, module, description }));
  await db.insert(permissions).values(rows).onConflictDoUpdate({
    target: permissions.code,
    set: { module: sql`excluded.module`, description: sql`excluded.description` },
  });
}
