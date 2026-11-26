import {
  pgTable, uuid, text, timestamp, boolean, integer, date, pgEnum, uniqueIndex, index, numeric, time, jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { institutions, institutionBranches, users } from './core.js';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};
const tenant = () => uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' });

export const termKindEnum = pgEnum('term_kind', ['term', 'semester', 'trimester', 'quarter']);
export const subjectKindEnum = pgEnum('subject_kind', ['theory', 'lab', 'practical', 'activity', 'other']);
export const studentStatusEnum = pgEnum('student_status', ['active', 'inactive', 'withdrawn', 'transferred', 'alumni', 'suspended']);
export const staffStatusEnum = pgEnum('staff_status', ['active', 'on_leave', 'resigned', 'retired', 'inactive']);
export const calendarEventKindEnum = pgEnum('calendar_event_kind', ['holiday', 'exam', 'event', 'vacation', 'special_working_day', 'half_day']);

export const academicYears = pgTable('academic_years', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  isCurrent: boolean('is_current').notNull().default(false),
  ...timestamps,
}, (t) => [
  uniqueIndex('ay_inst_name_uq').on(t.institutionId, t.name),
  uniqueIndex('ay_inst_current_uq').on(t.institutionId).where(sql`${t.isCurrent} = true`),
]);

export const academicTerms = pgTable('academic_terms', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  academicYearId: uuid('academic_year_id').notNull().references(() => academicYears.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: termKindEnum('kind').notNull().default('term'),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('term_year_name_uq').on(t.academicYearId, t.name)]);

export const departments = pgTable('departments', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  branchId: uuid('branch_id').references(() => institutionBranches.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  code: text('code').notNull(),
  headStaffId: uuid('head_staff_id'),
  ...timestamps,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [uniqueIndex('dept_inst_code_uq').on(t.institutionId, t.code)]);

export const programmes = pgTable('programmes', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  code: text('code').notNull(),
  durationYears: integer('duration_years').notNull().default(1),
  ...timestamps,
}, (t) => [uniqueIndex('prog_inst_code_uq').on(t.institutionId, t.code)]);

/** Grade (school) or year-of-study (college). "academic_year_levels" in the product spec. */
export const classLevels = pgTable('class_levels', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  programmeId: uuid('programme_id').references(() => programmes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  ordinal: integer('ordinal').notNull().default(0),
  ...timestamps,
}, (t) => [index('class_levels_inst_idx').on(t.institutionId)]);

export const subjects = pgTable('subjects', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  code: text('code').notNull(),
  kind: subjectKindEnum('kind').notNull().default('theory'),
  credits: numeric('credits', { precision: 4, scale: 1 }),
  isElective: boolean('is_elective').notNull().default(false),
  ...timestamps,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [uniqueIndex('subject_inst_code_uq').on(t.institutionId, t.code)]);

export const staff = pgTable('staff', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  employeeId: text('employee_id').notNull(),
  fullName: text('full_name').notNull(),
  email: text('email'),
  phone: text('phone'),
  designation: text('designation'),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
  employmentStatus: staffStatusEnum('employment_status').notNull().default('active'),
  joiningDate: date('joining_date'),
  photoUrl: text('photo_url'),
  isDemo: boolean('is_demo').notNull().default(false),
  ...timestamps,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('staff_inst_emp_uq').on(t.institutionId, t.employeeId),
  index('staff_user_idx').on(t.userId),
]);

/** A section (class instance) in an academic year, e.g. Grade 10-A or B.Tech CSE III-A. */
export const sections = pgTable('sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  academicYearId: uuid('academic_year_id').notNull().references(() => academicYears.id, { onDelete: 'cascade' }),
  classLevelId: uuid('class_level_id').notNull().references(() => classLevels.id, { onDelete: 'cascade' }),
  termId: uuid('term_id').references(() => academicTerms.id, { onDelete: 'set null' }),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  classTeacherStaffId: uuid('class_teacher_staff_id').references(() => staff.id, { onDelete: 'set null' }),
  capacity: integer('capacity'),
  ...timestamps,
}, (t) => [
  uniqueIndex('section_year_level_name_uq').on(t.academicYearId, t.classLevelId, t.name),
  index('section_inst_idx').on(t.institutionId),
]);

/** A subject taught to a group by a faculty member ("faculty_assignments"). May span sections (electives). */
export const courseOfferings = pgTable('course_offerings', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  academicYearId: uuid('academic_year_id').notNull().references(() => academicYears.id, { onDelete: 'cascade' }),
  termId: uuid('term_id').references(() => academicTerms.id, { onDelete: 'set null' }),
  subjectId: uuid('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
  sectionId: uuid('section_id').references(() => sections.id, { onDelete: 'cascade' }),
  staffId: uuid('staff_id').references(() => staff.id, { onDelete: 'set null' }),
  /** When true, roster = all active students of section; otherwise explicit subject_enrolments. */
  autoEnrolSection: boolean('auto_enrol_section').notNull().default(true),
  label: text('label'),
  ...timestamps,
}, (t) => [index('offering_inst_year_idx').on(t.institutionId, t.academicYearId), index('offering_staff_idx').on(t.staffId), index('offering_section_idx').on(t.sectionId)]);

export const students = pgTable('students', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  admissionNumber: text('admission_number').notNull(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull().default(''),
  dateOfBirth: date('date_of_birth'),
  gender: text('gender'),
  photoUrl: text('photo_url'),
  admissionDate: date('admission_date'),
  email: text('email'),
  phone: text('phone'),
  address: text('address'),
  status: studentStatusEnum('status').notNull().default('active'),
  emergencyContact: jsonb('emergency_contact').$type<{ name?: string; phone?: string; relationship?: string }>(),
  /** Restricted: only returned to holders of students.medical.read */
  medicalNotes: text('medical_notes'),
  previousInstitution: text('previous_institution'),
  /** Opaque identifier for ID-card QR codes. Never encodes personal data. */
  identityToken: text('identity_token').notNull().default(sql`replace(gen_random_uuid()::text, '-', '')`),
  isDemo: boolean('is_demo').notNull().default(false),
  ...timestamps,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('student_inst_adm_uq').on(t.institutionId, t.admissionNumber),
  uniqueIndex('student_identity_token_uq').on(t.identityToken),
  index('student_user_idx').on(t.userId),
  index('student_inst_name_idx').on(t.institutionId, t.firstName, t.lastName),
]);

export const studentEnrolments = pgTable('student_enrolments', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
  academicYearId: uuid('academic_year_id').notNull().references(() => academicYears.id, { onDelete: 'cascade' }),
  sectionId: uuid('section_id').notNull().references(() => sections.id, { onDelete: 'cascade' }),
  rollNumber: text('roll_number'),
  isActive: boolean('is_active').notNull().default(true),
  startDate: date('start_date'),
  endDate: date('end_date'),
  ...timestamps,
}, (t) => [
  uniqueIndex('enrol_student_year_active_uq').on(t.studentId, t.academicYearId).where(sql`${t.isActive} = true`),
  index('enrol_section_idx').on(t.sectionId),
]);

export const subjectEnrolments = pgTable('subject_enrolments', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  courseOfferingId: uuid('course_offering_id').notNull().references(() => courseOfferings.id, { onDelete: 'cascade' }),
  studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
  ...timestamps,
}, (t) => [uniqueIndex('subj_enrol_uq').on(t.courseOfferingId, t.studentId), index('subj_enrol_student_idx').on(t.studentId)]);

export const studentStatusHistory = pgTable('student_status_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  reason: text('reason'),
  changedByUserId: uuid('changed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const guardians = pgTable('guardians', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  fullName: text('full_name').notNull(),
  email: text('email'),
  phone: text('phone'),
  occupation: text('occupation'),
  isDemo: boolean('is_demo').notNull().default(false),
  ...timestamps,
}, (t) => [index('guardian_user_idx').on(t.userId), index('guardian_inst_idx').on(t.institutionId)]);

export const studentGuardians = pgTable('student_guardians', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
  guardianId: uuid('guardian_id').notNull().references(() => guardians.id, { onDelete: 'cascade' }),
  relationship: text('relationship').notNull().default('guardian'),
  isPrimary: boolean('is_primary').notNull().default(false),
  receivesNotifications: boolean('receives_notifications').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('student_guardian_uq').on(t.studentId, t.guardianId), index('sg_guardian_idx').on(t.guardianId)]);

/** Bell schedule slots. */
export const periods = pgTable('periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  name: text('name').notNull(),
  ordinal: integer('ordinal').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  isBreak: boolean('is_break').notNull().default(false),
  ...timestamps,
}, (t) => [uniqueIndex('period_inst_ordinal_uq').on(t.institutionId, t.ordinal)]);

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('classroom'),
  capacity: integer('capacity'),
  ...timestamps,
}, (t) => [uniqueIndex('room_inst_name_uq').on(t.institutionId, t.name)]);

export const timetableEntries = pgTable('timetable_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  academicYearId: uuid('academic_year_id').notNull().references(() => academicYears.id, { onDelete: 'cascade' }),
  courseOfferingId: uuid('course_offering_id').notNull().references(() => courseOfferings.id, { onDelete: 'cascade' }),
  /** ISO weekday 1=Mon..7=Sun */
  dayOfWeek: integer('day_of_week').notNull(),
  periodId: uuid('period_id').notNull().references(() => periods.id, { onDelete: 'cascade' }),
  roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'set null' }),
  effectiveFrom: date('effective_from'),
  effectiveTo: date('effective_to'),
  ...timestamps,
}, (t) => [index('tt_inst_day_idx').on(t.institutionId, t.dayOfWeek), index('tt_offering_idx').on(t.courseOfferingId)]);

export const calendarEvents = pgTable('calendar_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  academicYearId: uuid('academic_year_id').references(() => academicYears.id, { onDelete: 'cascade' }),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'cascade' }),
  kind: calendarEventKindEnum('kind').notNull(),
  title: text('title').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  ...timestamps,
}, (t) => [index('cal_inst_dates_idx').on(t.institutionId, t.startDate, t.endDate)]);
