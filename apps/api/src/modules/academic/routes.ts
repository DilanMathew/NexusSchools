import { Router } from 'express';
import { z } from 'zod';
import { and, eq, ne, sql } from 'drizzle-orm';
import { tenantCrud } from '../../lib/tenant-crud.js';
import { isoDate } from '../../lib/http.js';
import { AppError, badRequest } from '../../lib/errors.js';
import {
  academicYears, academicTerms, departments, programmes, classLevels, subjects, sections, courseOfferings, staff,
  periods, rooms, calendarEvents, institutionBranches,
} from '../../db/schema/index.js';
import type { DbOrTx } from '../../db/client.js';

const R: ['academic.read'] = ['academic.read'];
const W: ['academic.manage'] = ['academic.manage'];
const dateRange = <T extends z.ZodRawShape>(shape: T) => z.object({ ...shape, startDate: isoDate, endDate: isoDate });
const checkRange = async (_c: DbOrTx, _i: string, d: Record<string, unknown>) => {
  if (d.startDate && d.endDate && (d.startDate as string) > (d.endDate as string)) throw badRequest('startDate must be on or before endDate');
};

export const academicRouter = Router();

/** Refuse deleting structure that attendance history depends on (deletion would cascade and lose records). */
const protectAttendance = (sqlWhere: (id: string) => ReturnType<typeof sql>) => async (conn: DbOrTx, inst: string, id: string) => {
  const r = await conn.execute<{ n: number }>(sql`select count(*)::int as n from attendance_sessions where institution_id = ${inst} and ${sqlWhere(id)}`);
  if (r.rows[0].n > 0) throw new AppError(409, 'HAS_ATTENDANCE', `This cannot be deleted: ${r.rows[0].n} attendance session(s) depend on it. Keep it, or archive instead.`);
};

academicRouter.use('/years', tenantCrud({
  table: academicYears, entity: 'Academic year', readPermission: ['academic.read', 'attendance.self.read', 'attendance.child.read'], writePermission: W,
  createSchema: dateRange({ name: z.string().trim().min(2).max(40), isCurrent: z.boolean().optional() }),
  orderBy: [academicYears.startDate],
  beforeDelete: protectAttendance((id) => sql`(section_id in (select id from sections where academic_year_id = ${id}) or course_offering_id in (select id from course_offerings where academic_year_id = ${id}))`),
  beforeWrite: async (tx, inst, d, id) => {
    await checkRange(tx, inst, d);
    if (d.isCurrent) await tx.update(academicYears).set({ isCurrent: false }).where(and(eq(academicYears.institutionId, inst), id ? ne(academicYears.id, id) : undefined));
  },
}));

academicRouter.use('/terms', tenantCrud({
  table: academicTerms, entity: 'Academic term', readPermission: R, writePermission: W,
  createSchema: dateRange({ academicYearId: z.string().uuid(), name: z.string().trim().min(1).max(40), kind: z.enum(['term', 'semester', 'trimester', 'quarter']).default('term') }),
  refs: { academicYearId: academicYears }, filters: { academicYearId: academicTerms.academicYearId }, orderBy: [academicTerms.startDate], beforeWrite: checkRange,
}));

academicRouter.use('/departments', tenantCrud({
  table: departments, entity: 'Department', readPermission: R, writePermission: W, softDelete: true,
  createSchema: z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().min(1).max(20).toUpperCase(), branchId: z.string().uuid().nullable().optional(), headStaffId: z.string().uuid().nullable().optional() }),
  refs: { branchId: institutionBranches, headStaffId: staff }, searchColumns: [departments.name, departments.code], orderBy: [departments.name],
}));

academicRouter.use('/programmes', tenantCrud({
  table: programmes, entity: 'Programme', readPermission: R, writePermission: W,
  createSchema: z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().min(1).max(20).toUpperCase(), departmentId: z.string().uuid().nullable().optional(), durationYears: z.number().int().min(1).max(10).default(1) }),
  refs: { departmentId: departments }, filters: { departmentId: programmes.departmentId }, orderBy: [programmes.name],
}));

academicRouter.use('/class-levels', tenantCrud({
  table: classLevels, entity: 'Class level', readPermission: R, writePermission: W,
  createSchema: z.object({ name: z.string().trim().min(1).max(60), ordinal: z.number().int().min(0).max(100).default(0), programmeId: z.string().uuid().nullable().optional() }),
  refs: { programmeId: programmes }, filters: { programmeId: classLevels.programmeId }, orderBy: [classLevels.ordinal, classLevels.name],
  beforeDelete: protectAttendance((id) => sql`section_id in (select id from sections where class_level_id = ${id})`),
}));

academicRouter.use('/subjects', tenantCrud({
  table: subjects, entity: 'Subject', readPermission: R, writePermission: W, softDelete: true,
  createSchema: z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().min(1).max(20).toUpperCase(), kind: z.enum(['theory', 'lab', 'practical', 'activity', 'other']).default('theory'), departmentId: z.string().uuid().nullable().optional(), credits: z.string().regex(/^\d{1,2}(\.\d)?$/).nullable().optional(), isElective: z.boolean().default(false) }),
  refs: { departmentId: departments }, filters: { departmentId: subjects.departmentId, kind: subjects.kind }, searchColumns: [subjects.name, subjects.code], orderBy: [subjects.name],
}));

academicRouter.use('/sections', tenantCrud({
  table: sections, entity: 'Section', readPermission: R, writePermission: W,
  createSchema: z.object({ academicYearId: z.string().uuid(), classLevelId: z.string().uuid(), name: z.string().trim().min(1).max(20), termId: z.string().uuid().nullable().optional(), departmentId: z.string().uuid().nullable().optional(), classTeacherStaffId: z.string().uuid().nullable().optional(), capacity: z.number().int().min(1).max(1000).nullable().optional() }),
  refs: { academicYearId: academicYears, classLevelId: classLevels, termId: academicTerms, departmentId: departments, classTeacherStaffId: staff },
  filters: { academicYearId: sections.academicYearId, classLevelId: sections.classLevelId, departmentId: sections.departmentId, classTeacherStaffId: sections.classTeacherStaffId },
  orderBy: [sections.name],
  beforeDelete: protectAttendance((id) => sql`(section_id = ${id} or course_offering_id in (select id from course_offerings where section_id = ${id}))`),
}));

academicRouter.use('/offerings', tenantCrud({
  table: courseOfferings, entity: 'Course offering', readPermission: ['academic.read', 'timetable.read'], writePermission: W,
  createSchema: z.object({ academicYearId: z.string().uuid(), subjectId: z.string().uuid(), sectionId: z.string().uuid().nullable().optional(), staffId: z.string().uuid().nullable().optional(), termId: z.string().uuid().nullable().optional(), autoEnrolSection: z.boolean().default(true), label: z.string().max(120).nullable().optional() }),
  refs: { academicYearId: academicYears, subjectId: subjects, sectionId: sections, staffId: staff, termId: academicTerms },
  filters: { academicYearId: courseOfferings.academicYearId, sectionId: courseOfferings.sectionId, staffId: courseOfferings.staffId, subjectId: courseOfferings.subjectId },
  beforeDelete: protectAttendance((id) => sql`course_offering_id = ${id}`),
  beforeWrite: async (_tx, _i, d) => { if (d.autoEnrolSection && d.sectionId === null) throw badRequest('autoEnrolSection requires a sectionId'); },
}));

academicRouter.use('/periods', tenantCrud({
  table: periods, entity: 'Period', readPermission: ['academic.read', 'timetable.read'], writePermission: ['academic.manage', 'timetable.manage'],
  createSchema: z.object({ name: z.string().trim().min(1).max(40), ordinal: z.number().int().min(0).max(30), startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/), endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/), isBreak: z.boolean().default(false) }),
  orderBy: [periods.ordinal],
  beforeWrite: async (_c, _i, d) => { if (d.startTime && d.endTime && (d.startTime as string) >= (d.endTime as string)) throw badRequest('Period must end after it starts'); },
}));

academicRouter.use('/rooms', tenantCrud({
  table: rooms, entity: 'Room', readPermission: ['academic.read', 'timetable.read'], writePermission: ['academic.manage', 'timetable.manage'],
  createSchema: z.object({ name: z.string().trim().min(1).max(60), kind: z.enum(['classroom', 'lab', 'hall', 'other']).default('classroom'), capacity: z.number().int().min(1).max(5000).nullable().optional() }),
  orderBy: [rooms.name],
}));

academicRouter.use('/calendar', tenantCrud({
  table: calendarEvents, entity: 'Calendar event', readPermission: ['academic.read', 'attendance.self.read', 'attendance.child.read', 'timetable.read'], writePermission: ['calendar.manage', 'academic.manage'],
  createSchema: dateRange({ kind: z.enum(['holiday', 'exam', 'event', 'vacation', 'special_working_day', 'half_day']), title: z.string().trim().min(2).max(150), academicYearId: z.string().uuid().nullable().optional(), departmentId: z.string().uuid().nullable().optional() }),
  refs: { academicYearId: academicYears, departmentId: departments }, filters: { kind: calendarEvents.kind, academicYearId: calendarEvents.academicYearId }, orderBy: [calendarEvents.startDate], beforeWrite: checkRange,
}));
