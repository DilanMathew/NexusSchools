# Architecture

## Overview

```
apps/
  api/   Express 5 + TypeScript + Drizzle ORM (PostgreSQL)   — REST API, attendance engine, device ingest
  web/   React 18 + Vite + Tailwind 4 + TanStack Query        — single-page app / installable PWA
```

In production both run as **one service**: the API serves the built web app from `STATIC_DIR`, so the browser talks to a single origin (no CORS, first-party cookies). See `DEPLOYMENT.md`.

## Request flow

1. `helmet` (CSP, security headers) → CORS → JSON body (1 MB limit) → global rate limit.
2. `/api/auth/*` — public auth endpoints (own stricter rate limits).
3. `/api/platform/*` — platform super-admin only (`requirePlatformAdmin`). Aggregates and institution metadata; no student-level data.
4. `/api/device/events` — hardware ingest, authenticated by a per-device key (`X-Device-Key`), not a user session.
5. `/api/t/*` — **every tenant route**:
   - `authenticate` verifies the access JWT and that the user is active.
   - `tenant` reads `X-Institution-Id`, loads the caller's **active membership** in that institution from the database, and builds `req.ctx` (roles, permissions, linked staff/student/guardian ids). No membership → 403. Suspended institution → 403.
   - `requirePermission(...)` gates each route.
   - Handlers always filter by `req.ctx.institutionId`; any referenced id in a body is checked with `assertOwned` so a record from another tenant can never be linked.

## Modules (`apps/api/src/modules`)

| Module | Responsibility |
|---|---|
| auth | registration/onboarding, login + lockout, refresh-token rotation with reuse detection, password change/reset |
| institutions | profile, branding, modules, branches, audit log, JSON export; `provision.ts` creates a fully configured tenant |
| rbac | permission catalogue, system role templates, additive sync to existing tenants |
| users | memberships, role assignment (escalation-proof), custom roles |
| platform | super-admin console APIs |
| academic | years, terms, departments, programmes, class levels, sections, subjects, course offerings, periods, rooms, calendar (generic `tenantCrud`) |
| students | students, enrolments, transfers, promotion, CSV import, ID cards; guardians |
| staff | staff, workload, staff leave |
| attendance | **engine** (pure calculation), scope rules, sessions, marking, submission, corrections, correction requests, QR, offline sync |
| timetable | timetable grid, conflict detection |
| analytics / reports | dashboards, at-risk lists, compliance, registers, exports (JSON/CSV/XLSX) |
| leave, notifications, announcements | workflows and in-app notification centre with delivery log |
| ai | rule-based insights, data-quality checks, institutional assistant (LLM or built-in) |
| devices | readers, RFID/NFC cards, campus presence, visitors, vendor adapters |
| exams | examination eligibility indicators, exemptions, official decisions |

## Key design decisions

- **Configurable, not hardcoded.** Institution type only chooses *defaults* (modules, terminology, policy). Everything is editable per institution.
- **One calculation engine.** `attendance/engine.ts` is pure and unit-tested; dashboards, reports, portal, exams and the assistant all call it. Reports embed the policy snapshot/version they used.
- **History is never overwritten.** Submitted attendance changes only through audited corrections (`attendance_corrections` keeps old/new/reason/who/approver).
- **Campus presence ≠ class attendance.** Gate events live in `campus_events` and never create attendance records.
- **AI is optional.** The platform works fully without an AI provider; the assistant falls back to a built-in question set.
- **Demo data is isolated.** Demo tenants are flagged `is_demo`; reseeding touches only them.

## Frontend

- Access token kept in memory; refresh token in an httpOnly, SameSite=Strict cookie scoped to `/api/auth`.
- Role-based navigation driven by the permission list returned from `/api/auth/me` (the server still enforces every permission).
- Offline attendance: marks are queued in local storage and replayed through `/api/t/attendance/sync`; items leave the queue only when the server reports `applied` or `conflict`.
- Service worker caches the app shell only; API responses are never cached.
