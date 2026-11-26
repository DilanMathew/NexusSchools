CREATE TYPE "public"."card_status" AS ENUM('active', 'lost', 'replaced', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."device_kind" AS ENUM('rfid_reader', 'nfc_reader', 'qr_gate', 'other');--> statement-breakpoint
CREATE TYPE "public"."eligibility_status" AS ENUM('computed', 'exempted', 'confirmed_eligible', 'confirmed_ineligible');--> statement-breakpoint
CREATE TABLE "campus_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" uuid,
	"device_id" uuid,
	"direction" text NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text NOT NULL,
	"unresolved_identifier" text,
	"recorded_by_user_id" uuid,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "examination_eligibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"examination_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"percentage" numeric(5, 2),
	"attended" numeric(8, 2),
	"conducted" numeric(8, 2),
	"meets_threshold" boolean DEFAULT false NOT NULL,
	"status" "eligibility_status" DEFAULT 'computed' NOT NULL,
	"exemption_reason" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "examination_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"academic_year_id" uuid NOT NULL,
	"term_id" uuid,
	"name" text NOT NULL,
	"attendance_from" date NOT NULL,
	"attendance_to" date NOT NULL,
	"threshold" numeric(5, 2) NOT NULL,
	"computed_at" timestamp with time zone,
	"policy_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registered_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "device_kind" NOT NULL,
	"adapter" text DEFAULT 'generic-json' NOT NULL,
	"location" text,
	"purpose" text DEFAULT 'campus_entry' NOT NULL,
	"key_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfid_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"card_uid" text NOT NULL,
	"status" "card_status" DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visitor_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"phone" text,
	"visiting_student_id" uuid,
	"check_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_out_at" timestamp with time zone,
	"recorded_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "campus_events" ADD CONSTRAINT "campus_events_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_events" ADD CONSTRAINT "campus_events_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_events" ADD CONSTRAINT "campus_events_device_id_registered_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."registered_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_events" ADD CONSTRAINT "campus_events_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_eligibility" ADD CONSTRAINT "examination_eligibility_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_eligibility" ADD CONSTRAINT "examination_eligibility_examination_id_examination_sessions_id_fk" FOREIGN KEY ("examination_id") REFERENCES "public"."examination_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_eligibility" ADD CONSTRAINT "examination_eligibility_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_eligibility" ADD CONSTRAINT "examination_eligibility_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_sessions" ADD CONSTRAINT "examination_sessions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_sessions" ADD CONSTRAINT "examination_sessions_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_sessions" ADD CONSTRAINT "examination_sessions_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registered_devices" ADD CONSTRAINT "registered_devices_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfid_cards" ADD CONSTRAINT "rfid_cards_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfid_cards" ADD CONSTRAINT "rfid_cards_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_logs" ADD CONSTRAINT "visitor_logs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_logs" ADD CONSTRAINT "visitor_logs_visiting_student_id_students_id_fk" FOREIGN KEY ("visiting_student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_logs" ADD CONSTRAINT "visitor_logs_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campus_dedupe_uq" ON "campus_events" USING btree ("institution_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "campus_inst_time_idx" ON "campus_events" USING btree ("institution_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_elig_uq" ON "examination_eligibility" USING btree ("examination_id","student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_key_uq" ON "registered_devices" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "card_uid_active_uq" ON "rfid_cards" USING btree ("institution_id","card_uid") WHERE "rfid_cards"."status" = 'active';--> statement-breakpoint
CREATE INDEX "card_student_idx" ON "rfid_cards" USING btree ("student_id");