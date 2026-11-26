# NEXUS AttendIQ — Implementation status

_Updated 26 Nov 2026. Live demo: https://attendiq-app-production.up.railway.app (demo data only)._

**Verification:**
- 56 automated API tests pass (`npm test`).
- The API and web app typecheck and build.
- A browser sweep across 7 roles and every screen showed no JavaScript errors and no failed API calls.

## Complete

| Area | What works |
|---|---|
| SaaS & tenancy | Institution registration and onboarding by type, branding, modules, branches, suspension, JSON export, audit log, strict tenant isolation (tested) |
| Roles | 10 system roles plus custom roles, 46 permissions enforced server-side, escalation-proof role grants, additive permission sync for existing tenants |
| Academic structure | Years, terms/semesters, departments, programmes, classes / years of study, sections, subjects, subject allocation (incl. electives), periods, rooms, calendar, setup checklist |
| Students & guardians | CRUD, profiles, status history, transfers, promotion, CSV import with preview / duplicates / errors, duplicate detection, portal logins, ID cards with opaque QR + reissue |
| Staff | CRUD, logins, workload, staff leave workflow |
| Attendance | Policy-driven engine, versioned policy, daily / period / subject / lab / event sessions, fast marking UI, deadlines, audited corrections, student/parent correction requests, cancellation |
| QR attendance | Rotating signed codes, scan page with camera, replay and duplicate protection, suspicious-scan flag |
| Offline | Teacher offline queue + sync with conflict reporting, PWA install, app-shell caching |
| Timetable | Grid by class, faculty or room; drag-and-drop; clash prevention; clash scan |
| Portals | Student and parent: attendance, subject-wise, monthly, shortage calculator, history, correction requests, leave, timetable, notifications |
| Leave | Student/parent apply → class teacher review → notifications. Leave never rewrites attendance |
| Notifications | In-app notification centre, preferences, delivery log per channel, announcements with audience, scheduling and expiry |
| Reports | Attendance/eligibility, class, subject, department, shortage, late, monthly and daily registers, consecutive absences, submission compliance. Export to Excel (.xlsx), CSV, or print / save as PDF |
| Dashboards | Admin/principal (scoped for HOD), teacher, student/parent, platform |
| Insights & AI | At-risk list with explanations, attendance-drop detection, data-quality checks, institutional assistant (LLM when configured, built-in otherwise; permission-scoped, read-only, logged, plan-capped) |
| Devices & campus | Reader registration (key shown once), vendor adapter layer, RFID/NFC cards (assign/replace/lost), idempotent offline-safe ingest, campus summary (late, early departure, on campus), manual gate entry, visitor log |
| Exams | Exam setup, eligibility computation, exemptions, separate official confirmation permission, CSV |
| Deployment | Single-service Docker build, Railway project with Postgres, health checks, auto-migrations, versioned demo seed |
| Docs | README, ARCHITECTURE, DATABASE_SCHEMA, API_DOCUMENTATION, ATTENDANCE_ENGINE, AI_AGENT_DESIGN, SECURITY, DEPLOYMENT, ENVIRONMENT_VARIABLES, TESTING (in `docs/`) |

## Not done, and why

| Item | Status |
|---|---|
| Email / SMS / WhatsApp / push delivery | The adapter interface and per-channel delivery log are in place. Each channel needs **provider credentials** (e.g. an SMTP/SES key, an SMS gateway, a WhatsApp Business account, Web Push VAPID keys). Until a provider is configured, these deliveries are logged as `skipped`. |
| LLM assistant on the live site | Implemented. Needs an `ANTHROPIC_API_KEY` set as a Railway secret with `AI_PROVIDER=anthropic`; until then the built-in mode answers. |
| Subscription payments | Plans, trials, limits from the database, and admin plan changes all work. Online payment needs a payment gateway account (e.g. Razorpay) and is not implemented. Plan limits are enforced for the AI assistant only, not yet for student and staff counts. |
| DPDP consent and data-rights workflows, privacy policy, terms | Need legal input; see `docs/SECURITY.md`. |
| Location-assisted attendance (geofence) | Not implemented; the module toggle is marked "no effect yet". |
| Faculty substitution timetable | Not implemented (admins can take attendance for any class). |
| Photo and document uploads | Need object storage (e.g. a Railway bucket); photo URLs only for now. |
| Redis / BullMQ background jobs | Not needed yet: notifications are written in the request transaction. Needed once external channels and scheduled messages are added. |
| Tamil UI translation | The locale setting exists; the UI strings are English only. |
| LLM parent-message drafting, daily narrative summaries | Not implemented. |
| Committed browser end-to-end tests in CI | A manual Playwright sweep was run; CI tests are still to do. |
| Support-access grant workflow for platform staff | Table only. |
