import {
  pgTable, uuid, text, timestamp, boolean, integer, date, pgEnum, uniqueIndex, index, numeric, jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { institutions, users } from './core.js';
import { students, sections, courseOfferings, periods, timetableEntries, staff } from './academic.js';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};
const tenant = () => uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' });

export const ATTENDANCE_STATUSES = [
  'present', 'absent', 'late', 'half_day', 'on_leave', 'excused', 'medical_leave', 'on_duty', 'holiday', 'not_applicable', 'pending_verification',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const attendanceStatusEnum = pgEnum('attendance_status', ATTENDANCE_STATUSES);
export const attendanceKindEnum = pgEnum('attendance_kind', ['daily', 'period', 'subject', 'lab', 'practical', 'assembly', 'event', 'exam', 'transport']);
export const attendanceMethodEnum = pgEnum('attendance_method', ['manual', 'qr', 'rfid', 'nfc', 'location', 'offline', 'import']);
export const attendanceSessionStatusEnum = pgEnum('attendance_session_status', ['open', 'submitted', 'locked', 'cancelled']);
export const correctionRequestStatusEnum = pgEnum('correction_request_status', ['pending', 'approved', 'rejected', 'info_requested', 'withdrawn']);
export const leaveStatusEnum = pgEnum('leave_status', ['pending', 'approved', 'rejected', 'cancelled']);
export const notificationChannelEnum = pgEnum('notification_channel', ['in_app', 'email', 'sms', 'whatsapp', 'push']);
export const deliveryStatusEnum = pgEnum('delivery_status', ['queued', 'sent', 'delivered', 'failed', 'skipped']);

/**
 * How percentages are computed. Each institution configures its own; reports embed the snapshot
 * (and version) they were computed with so results are reproducible.
 */
export const attendancePolicies = pgTable('attendance_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  name: text('name').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  version: integer('version').notNull().default(1),
  /** 'session' (each period/session counts) or 'day' (one daily register per day). */
  calculationUnit: text('calculation_unit').notNull().default('session'),
  enabledStatuses: text('enabled_statuses').array().notNull().default(sql`ARRAY['present','absent','late','on_leave','medical_leave','on_duty']`),
  /** weight given to each status: 1 = attended, 0 = not attended, null = excluded from denominator */
  lateWeight: numeric('late_weight', { precision: 3, scale: 2 }).default('1'),
  halfDayWeight: numeric('half_day_weight', { precision: 3, scale: 2 }).default('0.5'),
  onDutyCountsAsPresent: boolean('on_duty_counts_as_present').notNull().default(true),
  /** 'exclude' | 'present' | 'absent' */
  approvedLeaveHandling: text('approved_leave_handling').notNull().default('exclude'),
  medicalLeaveHandling: text('medical_leave_handling').notNull().default('exclude'),
  excusedHandling: text('excused_handling').notNull().default('exclude'),
  excludeHolidays: boolean('exclude_holidays').notNull().default(true),
  excludeCancelledSessions: boolean('exclude_cancelled_sessions').notNull().default(true),
  separateLabAndTheory: boolean('separate_lab_and_theory').notNull().default(false),
  eligibilityThreshold: numeric('eligibility_threshold', { precision: 5, scale: 2 }).notNull().default('75'),
  warningThreshold: numeric('warning_threshold', { precision: 5, scale: 2 }).notNull().default('85'),
  /** minutes after a session's scheduled start within which attendance must be submitted */
  submissionDeadlineMinutes: integer('submission_deadline_minutes').notNull().default(1440),
  /** minutes after submission during which the submitting teacher may edit without a correction approval */
  teacherEditWindowMinutes: integer('teacher_edit_window_minutes').notNull().default(60),
  lateAfterMinutes: integer('late_after_minutes').notNull().default(10),
  ...timestamps,
}, (t) => [
  uniqueIndex('policy_inst_default_uq').on(t.institutionId).where(sql`${t.isDefault} = true`),
]);

export const attendanceSessions = pgTable('attendance_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  kind: attendanceKindEnum('kind').notNull(),
  sessionDate: date('session_date').notNull(),
  sectionId: uuid('section_id').references(() => sections.id, { onDelete: 'cascade' }),
  courseOfferingId: uuid('course_offering_id').references(() => courseOfferings.id, { onDelete: 'cascade' }),
  periodId: uuid('period_id').references(() => periods.id, { onDelete: 'set null' }),
  timetableEntryId: uuid('timetable_entry_id').references(() => timetableEntries.id, { onDelete: 'set null' }),
  takenByStaffId: uuid('taken_by_staff_id').references(() => staff.id, { onDelete: 'set null' }),
  method: attendanceMethodEnum('method').notNull().default('manual'),
  status: attendanceSessionStatusEnum('status').notNull().default('open'),
  title: text('title'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedByUserId: uuid('submitted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  cancelledReason: text('cancelled_reason'),
  /** Offline-captured sessions keep the client timestamp and are flagged for review. */
  clientCapturedAt: timestamp('client_captured_at', { withTimezone: true }),
  requiresVerification: boolean('requires_verification').notNull().default(false),
  isDemo: boolean('is_demo').notNull().default(false),
  ...timestamps,
}, (t) => [
  index('session_inst_date_idx').on(t.institutionId, t.sessionDate),
  index('session_offering_idx').on(t.courseOfferingId),
  index('session_section_idx').on(t.sectionId, t.sessionDate),
  // One live session per offering/date/period, and one daily register per section/date.
  uniqueIndex('session_offering_slot_uq').on(t.courseOfferingId, t.sessionDate, t.periodId)
    .where(sql`${t.status} <> 'cancelled' AND ${t.courseOfferingId} IS NOT NULL`),
  uniqueIndex('session_daily_uq').on(t.sectionId, t.sessionDate, t.kind)
    .where(sql`${t.status} <> 'cancelled' AND ${t.kind} = 'daily'`),
]);

export const attendanceRecords = pgTable('attendance_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  sessionId: uuid('session_id').notNull().references(() => attendanceSessions.id, { onDelete: 'cascade' }),
  studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
  status: attendanceStatusEnum('status').notNull(),
  method: attendanceMethodEnum('method').notNull().default('manual'),
  remarks: text('remarks'),
  markedByUserId: uuid('marked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
  ...timestamps,
}, (t) => [
  uniqueIndex('record_session_student_uq').on(t.sessionId, t.studentId),
  index('record_student_idx').on(t.institutionId, t.studentId),
]);

/** Immutable history of every change to an attendance record after it was first submitted. */
export const attendanceCorrections = pgTable('attendance_corrections', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  recordId: uuid('record_id').notNull().references(() => attendanceRecords.id, { onDelete: 'cascade' }),
  oldStatus: attendanceStatusEnum('old_status').notNull(),
  newStatus: attendanceStatusEnum('new_status').notNull(),
  reason: text('reason').notNull(),
  changedByUserId: uuid('changed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  correctionRequestId: uuid('correction_request_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('correction_record_idx').on(t.recordId)]);

export const attendanceCorrectionRequests = pgTable('attendance_correction_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  recordId: uuid('record_id').notNull().references(() => attendanceRecords.id, { onDelete: 'cascade' }),
  studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
  requestedByUserId: uuid('requested_by_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  requestedStatus: attendanceStatusEnum('requested_status').notNull(),
  reason: text('reason').notNull(),
  status: correctionRequestStatusEnum('status').notNull().default('pending'),
  reviewerUserId: uuid('reviewer_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewNote: text('review_note'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  index('corr_req_inst_status_idx').on(t.institutionId, t.status),
  uniqueIndex('corr_req_open_uq').on(t.recordId).where(sql`${t.status} IN ('pending','info_requested')`),
]);

/** Short-lived, rotating QR attendance session. Only a hash of the signing nonce is stored. */
export const qrSessions = pgTable('qr_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  attendanceSessionId: uuid('attendance_session_id').notNull().references(() => attendanceSessions.id, { onDelete: 'cascade' }),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  rotationSeconds: integer('rotation_seconds').notNull().default(15),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  requireLocation: boolean('require_location').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('qr_attendance_session_idx').on(t.attendanceSessionId)]);

export const qrScanEvents = pgTable('qr_scan_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  qrSessionId: uuid('qr_session_id').notNull().references(() => qrSessions.id, { onDelete: 'cascade' }),
  studentId: uuid('student_id').references(() => students.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  outcome: text('outcome').notNull(),
  userAgent: text('user_agent'),
  /** keyed hash of client IP, used only for duplicate/suspicious-scan detection */
  ipHash: text('ip_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('qr_scan_session_idx').on(t.qrSessionId, t.studentId)]);

export const leaveTypes = pgTable('leave_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** status applied to records when policy maps leave onto attendance */
  mapsToStatus: attendanceStatusEnum('maps_to_status').notNull().default('on_leave'),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
}, (t) => [uniqueIndex('leave_type_inst_code_uq').on(t.institutionId, t.code)]);

export const studentLeaveRequests = pgTable('student_leave_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
  leaveTypeId: uuid('leave_type_id').notNull().references(() => leaveTypes.id),
  requestedByUserId: uuid('requested_by_user_id').notNull().references(() => users.id),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  isPartialDay: boolean('is_partial_day').notNull().default(false),
  reason: text('reason').notNull(),
  status: leaveStatusEnum('status').notNull().default('pending'),
  reviewerUserId: uuid('reviewer_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewNote: text('review_note'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [index('leave_inst_status_idx').on(t.institutionId, t.status), index('leave_student_idx').on(t.studentId)]);

export const staffLeaveRequests = pgTable('staff_leave_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  staffId: uuid('staff_id').notNull().references(() => staff.id, { onDelete: 'cascade' }),
  leaveType: text('leave_type').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  reason: text('reason').notNull(),
  status: leaveStatusEnum('status').notNull().default('pending'),
  reviewerUserId: uuid('reviewer_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewNote: text('review_note'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  ...timestamps,
});

export const notificationTemplates = pgTable('notification_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').references(() => institutions.id, { onDelete: 'cascade' }),
  eventKey: text('event_key').notNull(),
  channel: notificationChannelEnum('channel').notNull(),
  language: text('language').notNull().default('en'),
  subject: text('subject'),
  body: text('body').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('tpl_uq').on(t.institutionId, t.eventKey, t.channel, t.language)]);

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  recipientUserId: uuid('recipient_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventKey: text('event_key').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  data: jsonb('data'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('notif_recipient_idx').on(t.recipientUserId, t.createdAt)]);

export const notificationDeliveryLogs = pgTable('notification_delivery_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  notificationId: uuid('notification_id').notNull().references(() => notifications.id, { onDelete: 'cascade' }),
  channel: notificationChannelEnum('channel').notNull(),
  status: deliveryStatusEnum('status').notNull().default('queued'),
  provider: text('provider'),
  providerMessageId: text('provider_message_id'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  ...timestamps,
}, (t) => [index('delivery_notif_idx').on(t.notificationId)]);

export const notificationPreferences = pgTable('notification_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventKey: text('event_key').notNull(),
  channel: notificationChannelEnum('channel').notNull(),
  enabled: boolean('enabled').notNull().default(true),
}, (t) => [uniqueIndex('pref_uq').on(t.institutionId, t.userId, t.eventKey, t.channel)]);

export const announcements = pgTable('announcements', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  /** 'institution' | 'department' | 'section' */
  scope: text('scope').notNull().default('institution'),
  scopeId: uuid('scope_id'),
  audience: text('audience').array().notNull().default(sql`ARRAY['students','guardians','staff']`),
  publishAt: timestamp('publish_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [index('ann_inst_publish_idx').on(t.institutionId, t.publishAt)]);

export const announcementReads = pgTable('announcement_reads', {
  announcementId: uuid('announcement_id').notNull().references(() => announcements.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('ann_read_uq').on(t.announcementId, t.userId)]);

export const aiUsageLogs = pgTable('ai_usage_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: tenant(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  agent: text('agent').notNull(),
  provider: text('provider').notNull(),
  model: text('model'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  toolCalls: jsonb('tool_calls'),
  status: text('status').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ai_usage_inst_idx').on(t.institutionId, t.createdAt)]);
