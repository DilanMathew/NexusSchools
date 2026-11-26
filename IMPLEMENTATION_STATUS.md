# NEXUS AttendIQ — Implementation status

_Checkpoint: 26 Nov 2026. Paused here at the user's request; resume from "Next up"._

## Done and tested

**Backend API (Express + TypeScript + Drizzle/PostgreSQL)** — 47 automated tests pass (`npm test`).

- **Multi-tenancy**: every tenant route needs a valid membership (from the `X-Institution-Id` header plus the logged-in user). Record IDs and foreign-key references are checked against the tenant. Isolation tests try cross-tenant read, update, delete and references.
- **Auth**: registration and onboarding, login with lockout after 5 failures, rotating refresh tokens (reuse revokes the whole token family), password change and reset, httpOnly cookie.
- **RBAC**: 42 permissions and 10 system roles per institution, plus custom roles. Privilege escalation is blocked.
- **Platform admin**: institution list and stats, suspend/activate, subscription change, platform audit. No implicit access to student data.
- **Academic structure**: years, terms, departments, programmes, class levels, sections, subjects, course offerings (electives), periods, rooms, calendar.
- **People**: students (CRUD, transfer, promotion, status history, CSV import with preview/validation/duplicate checks, duplicate detection, ID-card data with an opaque QR), guardians (links, logins), staff (logins, workload, staff leave).
- **Attendance engine**: policy-driven percentage (late/half-day weights, leave/OD/holiday handling, day vs session mode), versioned policy, eligibility bands, sessions-needed and max-missable, consecutive absences.
- **Attendance workflow**: timetable-driven sessions, draft/submit (atomic, roster-complete), submission deadlines, teacher edit window, audited corrections, student/parent correction requests, cancellation.
- **QR attendance**: HMAC-signed rotating tokens, replay/stale rejection, one scan per student, suspicious-scan flag.
- **Offline sync**: queue replay that never overwrites online submissions.
- **Timetable**: conflict detection (faculty, room and section) and a whole-timetable scan.
- **Leave**: apply, review, notify. Approval does not rewrite attendance.
- **Notifications**: in-app notifications with a delivery log. External channels are logged as `skipped`, because no provider is configured.
- **Reports** (JSON and CSV): student/class/subject/department/shortage/late, monthly register, daily register, consecutive absences, submission compliance.
- **Analytics**: dashboard overview, at-risk list, subject stats.
- **Rule-based insights**: attendance-drop detection and data-quality checks.
- **Demo seed**: ABC International School (504 students, 30 staff, daily register) and XYZ College of Engineering (1,216 students, 80 faculty, subject-wise), about 377k attendance records. All of it is labelled demo data.

**Web app (React + Vite + Tailwind + TanStack Query)** — builds and typechecks.

- Login, institution registration, forgot/reset password.
- App shell: role-based sidebar, institution switcher, notifications badge, offline indicator, mobile drawer.
- Admin/principal dashboard with live data.
- Teacher screens: today's classes, the fast marking screen (all present, search, undo, draft, submit), the QR display panel, correction with history, and the offline queue.
- Attendance records list and the corrections review queue.
- PWA manifest and service worker.

## Not done yet (next up, in order)

1. **Web screens whose APIs already exist**: student/parent portal (My attendance, shortage calculator, QR scan page), students list/profile/import, guardians, staff, academics setup, timetable grid (drag and drop), leave, reports, insights, announcements, notifications, settings (institution, modules, policy, users and roles, audit), platform console, ID-card print. These are hidden from the menu until built.
2. PDF/Excel exports (CSV only today). Bulk ID-card PDF sheets.
3. LLM assistant (Phase 7): provider abstraction, permission-aware tools, usage tracking. Today `/ai/status` reports it as unavailable.
4. Email/SMS/WhatsApp/push providers. Needs provider credentials; the adapter interface is in place.
5. RFID/NFC device APIs, geofence check, campus entry/exit, examination eligibility module, faculty substitution.
6. Subscription billing and payment, plan-limit enforcement, Redis/BullMQ jobs, file uploads (photos and documents).
7. Docs (ARCHITECTURE, DATABASE_SCHEMA, API, SECURITY, DEPLOYMENT, TESTING), end-to-end browser tests, Railway deployment, Tamil translations.

## Known limitations

- Platform support-access grants: the table exists but there is no workflow yet.
- Consent records under the DPDP Act still need to be designed with legal review.
