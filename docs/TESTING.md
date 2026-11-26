# Testing

```bash
npm test                          # API: unit + integration (Vitest + Supertest, real PostgreSQL)
npm run typecheck                 # API and web
```

The suite drops and recreates the schema in `TEST_DATABASE_URL` and then runs the migrations, so tests run against the real schema and constraints. 56 tests, all passing at the time of writing.

| File | Covers |
|---|---|
| `engine.test.ts` | percentage formula, late/half-day weights, leave/OD handling, day vs session mode, cancelled sessions, sessions-needed / max-missable, bands, consecutive absences |
| `units.test.ts` | timetable conflict detection, QR token signing / tamper / expiry, CSV formula-injection escaping |
| `auth-tenancy.test.ts` | registration, lockout, refresh rotation + reuse detection, weak passwords, **tenant isolation** (cross-tenant read/update/delete/reference/forged id/audit), RBAC and privilege escalation, custom roles, platform-only routes |
| `attendance.test.ts` | idempotent sessions, future dates, disabled statuses, QR scan and replay, complete submission + guardian notification, parent sees only own child, correction request → approval with history, teacher edit window and optimistic versioning, unassigned teacher blocked, offline sync conflicts, reports, versioned policy, leave flow, CSV import preview/commit, timetable clash, suspension, deletion safety |
| `ai-reports.test.ts` | assistant built-in mode, tenant-scoped answers, `ai.use` permission, real XLSX export |
| `devices-exams.test.ts` | device registration (key shown once), idempotent ingest, cross-tenant card refusal, lost cards, campus ≠ attendance, exam eligibility compute / exempt / confirm permissions, decisions surviving recompute |

## Browser checks

A Playwright sweep (not committed as CI) logged in as admin, principal, teacher, student, parent, gate operator and super-admin. It opened every screen against the seeded demo data and checked for JavaScript errors, failed API calls and error states; none were found. Committed browser end-to-end tests are still to do.
