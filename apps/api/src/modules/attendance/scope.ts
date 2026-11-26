import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sections, courseOfferings, subjects, studentEnrolments, subjectEnrolments, studentGuardians, students } from '../../db/schema/index.js';
import type { TenantContext } from '../../types.js';
import { forbidden } from '../../lib/errors.js';

export interface AttendanceScope {
  all: boolean;
  sectionIds: string[];
  offeringIds: string[];
  /** sections whose students are visible: sectionIds plus sections of visible auto-enrolled offerings */
  rosterSectionIds: string[];
}

/**
 * Which sections/offerings the caller can see attendance for.
 *  - attendance.read            → whole institution
 *  - attendance.read.department → sections/offerings in the caller's department
 *  - attendance.read.assigned   → sections they class-teach + offerings they teach
 */
export async function attendanceScope(ctx: TenantContext): Promise<AttendanceScope> {
  if (ctx.permissions.has('attendance.read')) return { all: true, sectionIds: [], offeringIds: [], rosterSectionIds: [] };
  const sectionIds = new Set<string>();
  const offeringIds = new Set<string>();
  const inst = ctx.institutionId;
  if (ctx.staffId && (ctx.permissions.has('attendance.read.assigned') || ctx.permissions.has('attendance.take'))) {
    (await db.select({ id: sections.id }).from(sections).where(and(eq(sections.institutionId, inst), eq(sections.classTeacherStaffId, ctx.staffId)))).forEach((r) => sectionIds.add(r.id));
    (await db.select({ id: courseOfferings.id }).from(courseOfferings).where(and(eq(courseOfferings.institutionId, inst), eq(courseOfferings.staffId, ctx.staffId)))).forEach((r) => offeringIds.add(r.id));
  }
  if (ctx.staffDepartmentId && ctx.permissions.has('attendance.read.department')) {
    (await db.select({ id: sections.id }).from(sections).where(and(eq(sections.institutionId, inst), eq(sections.departmentId, ctx.staffDepartmentId)))).forEach((r) => sectionIds.add(r.id));
    (await db.select({ id: courseOfferings.id }).from(courseOfferings).innerJoin(subjects, eq(subjects.id, courseOfferings.subjectId))
      .where(and(eq(courseOfferings.institutionId, inst), eq(subjects.departmentId, ctx.staffDepartmentId)))).forEach((r) => offeringIds.add(r.id));
  }
  // Offerings belonging to visible sections are visible too.
  if (sectionIds.size) {
    (await db.select({ id: courseOfferings.id }).from(courseOfferings).where(inArray(courseOfferings.sectionId, [...sectionIds]))).forEach((r) => offeringIds.add(r.id));
  }
  const roster = new Set(sectionIds);
  if (offeringIds.size) {
    (await db.select({ sid: courseOfferings.sectionId }).from(courseOfferings).where(and(inArray(courseOfferings.id, [...offeringIds]), eq(courseOfferings.autoEnrolSection, true))))
      .forEach((r) => r.sid && roster.add(r.sid));
  }
  return { all: false, sectionIds: [...sectionIds], offeringIds: [...offeringIds], rosterSectionIds: [...roster] };
}

/** True if the caller may view this student's attendance. Students → self; guardians → linked children; staff → scope. */
export async function canViewStudent(ctx: TenantContext, studentId: string, scope?: AttendanceScope): Promise<boolean> {
  // Tenant check first: a student from another institution is never visible, whatever the caller's role.
  const [own] = await db.select({ id: students.id }).from(students).where(and(eq(students.id, studentId), eq(students.institutionId, ctx.institutionId)));
  if (!own) return false;
  if (ctx.studentId === studentId && ctx.permissions.has('attendance.self.read')) return true;
  if (ctx.guardianId && ctx.permissions.has('attendance.child.read')) {
    const [l] = await db.select({ id: studentGuardians.id }).from(studentGuardians).where(and(eq(studentGuardians.guardianId, ctx.guardianId), eq(studentGuardians.studentId, studentId), eq(studentGuardians.institutionId, ctx.institutionId)));
    if (l) return true;
  }
  const s = scope ?? await attendanceScope(ctx);
  if (s.all) return true;
  if (!s.rosterSectionIds.length && !s.offeringIds.length) return false;
  const [hit] = await db.select({ one: sql<number>`1` }).from(studentEnrolments)
    .where(and(eq(studentEnrolments.studentId, studentId), eq(studentEnrolments.isActive, true), s.rosterSectionIds.length ? inArray(studentEnrolments.sectionId, s.rosterSectionIds) : sql`false`)).limit(1);
  if (hit) return true;
  const [hit2] = await db.select({ one: sql<number>`1` }).from(subjectEnrolments)
    .where(and(eq(subjectEnrolments.studentId, studentId), s.offeringIds.length ? inArray(subjectEnrolments.courseOfferingId, s.offeringIds) : sql`false`)).limit(1);
  return !!hit2;
}

export async function assertCanViewStudent(ctx: TenantContext, studentId: string) {
  if (!(await canViewStudent(ctx, studentId))) throw forbidden('You cannot view this student');
}
void or;
