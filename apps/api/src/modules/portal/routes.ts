import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { students, studentGuardians, studentEnrolments, sections, classLevels, academicYears } from '../../db/schema/index.js';

/** Self-service context for students and guardians: who am I, which children can I see. */
export const meRouter = Router();

meRouter.get('/students', async (req, res) => {
  const ctx = req.ctx!;
  const cols = { id: students.id, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, admissionNumber: students.admissionNumber, photoUrl: students.photoUrl, section: sections.name, classLevel: classLevels.name, rollNumber: studentEnrolments.rollNumber };
  const join = (q: ReturnType<typeof base>) => q;
  function base() {
    return db.select(cols).from(students)
      .leftJoin(studentEnrolments, and(eq(studentEnrolments.studentId, students.id), eq(studentEnrolments.isActive, true)))
      .leftJoin(academicYears, and(eq(academicYears.id, studentEnrolments.academicYearId), eq(academicYears.isCurrent, true)))
      .leftJoin(sections, eq(sections.id, studentEnrolments.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId)).$dynamic();
  }
  const out: unknown[] = [];
  if (ctx.studentId && ctx.permissions.has('attendance.self.read')) out.push(...(await join(base()).where(eq(students.id, ctx.studentId))).map((s) => ({ ...s, relation: 'self' })));
  if (ctx.guardianId && ctx.permissions.has('attendance.child.read')) {
    const kids = await base().innerJoin(studentGuardians, eq(studentGuardians.studentId, students.id)).where(and(eq(studentGuardians.guardianId, ctx.guardianId), eq(students.institutionId, ctx.institutionId)));
    out.push(...kids.map((k) => ({ ...k, relation: 'child' })));
  }
  res.json({ data: out });
});
