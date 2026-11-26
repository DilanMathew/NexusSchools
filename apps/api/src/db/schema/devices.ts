import { pgTable, uuid, text, timestamp, numeric, date, pgEnum, uniqueIndex, index, boolean, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { institutions, users } from './core.js';
import { students, academicYears, academicTerms } from './academic.js';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};
const tenant = () => uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' });

export const deviceKindEnum = pgEnum('device_kind', ['rfid_reader', 'nfc_reader', 'qr_gate', 'other']);
export const cardStatusEnum = pgEnum('card_status', ['active', 'lost', 'replaced', 'deactivated']);
export const eligibilityStatusEnum = pgEnum('eligibility_status', ['computed', 'exempted', 'confirmed_eligible', 'confirmed_ineligible']);

/** Attendance hardware. Authenticates with a per-device key; only its hash is stored. */
export const registeredDevices = pgTable('registered_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  name: text('name').notNull(),
  kind: deviceKindEnum('kind').notNull(),
  /** adapter id that normalises the vendor payload, e.g. 'generic-json' */
  adapter: text('adapter').notNull().default('generic-json'),
  location: text('location'),
  /** 'campus_entry' events feed campus presence; academic attendance is never inferred from them. */
  purpose: text('purpose').notNull().default('campus_entry'),
  keyHash: text('key_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  lastError: text('last_error'),
  ...timestamps,
}, (t) => [uniqueIndex('device_key_uq').on(t.keyHash)]);

export const rfidCards = pgTable('rfid_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
  cardUid: text('card_uid').notNull(),
  status: cardStatusEnum('status').notNull().default('active'),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  uniqueIndex('card_uid_active_uq').on(t.institutionId, t.cardUid).where(sql`${t.status} = 'active'`),
  index('card_student_idx').on(t.studentId),
]);

/** Campus presence (gate in/out). Kept separate from academic attendance records. */
export const campusEvents = pgTable('campus_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  studentId: uuid('student_id').references(() => students.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').references(() => registeredDevices.id, { onDelete: 'set null' }),
  direction: text('direction').notNull(),
  source: text('source').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  /** device-supplied event id; makes offline replays idempotent */
  dedupeKey: text('dedupe_key').notNull(),
  unresolvedIdentifier: text('unresolved_identifier'),
  recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  note: text('note'),
}, (t) => [uniqueIndex('campus_dedupe_uq').on(t.institutionId, t.dedupeKey), index('campus_inst_time_idx').on(t.institutionId, t.occurredAt)]);

export const visitorLogs = pgTable('visitor_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  name: text('name').notNull(),
  purpose: text('purpose').notNull(),
  phone: text('phone'),
  visitingStudentId: uuid('visiting_student_id').references(() => students.id, { onDelete: 'set null' }),
  checkInAt: timestamp('check_in_at', { withTimezone: true }).notNull().defaultNow(),
  checkOutAt: timestamp('check_out_at', { withTimezone: true }),
  recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
});

export const examinations = pgTable('examination_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  academicYearId: uuid('academic_year_id').notNull().references(() => academicYears.id, { onDelete: 'cascade' }),
  termId: uuid('term_id').references(() => academicTerms.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  attendanceFrom: date('attendance_from').notNull(),
  attendanceTo: date('attendance_to').notNull(),
  threshold: numeric('threshold', { precision: 5, scale: 2 }).notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }),
  policySnapshot: jsonb('policy_snapshot'),
  ...timestamps,
});

/** Attendance-based eligibility indicator. Official decisions are separate confirmed statuses. */
export const examEligibility = pgTable('examination_eligibility', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  examinationId: uuid('examination_id').notNull().references(() => examinations.id, { onDelete: 'cascade' }),
  studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
  percentage: numeric('percentage', { precision: 5, scale: 2 }),
  attended: numeric('attended', { precision: 8, scale: 2 }),
  conducted: numeric('conducted', { precision: 8, scale: 2 }),
  meetsThreshold: boolean('meets_threshold').notNull().default(false),
  status: eligibilityStatusEnum('status').notNull().default('computed'),
  exemptionReason: text('exemption_reason'),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [uniqueIndex('exam_elig_uq').on(t.examinationId, t.studentId)]);
