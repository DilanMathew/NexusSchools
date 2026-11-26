# API reference

**Base path:** `/api`.

**Responses:**
- Success: `{ "data": …, "meta"?: { page, pageSize, total, totalPages } }`
- Error: `{ "error": { "code", "message", "details"? } }`

**Auth:** `Authorization: Bearer <accessToken>`. Tenant routes (`/api/t/...`) also need `X-Institution-Id: <id of one of your institutions>`.

**List endpoints** accept `page`, `pageSize` and `search`, plus the filters listed below. Report endpoints accept `format=json|csv|xlsx`.

## Public / auth
| Method | Path | Notes |
|---|---|---|
| POST | /auth/register-institution | `{ institution: { name, type, … }, owner: { fullName, email, password } }` → tokens + tenant |
| POST | /auth/login | `{ email, password }` |
| POST | /auth/refresh | cookie + `X-Requested-With: attendiq` |
| POST | /auth/logout, /auth/change-password, /auth/forgot-password, /auth/reset-password | |
| GET | /auth/me | user, memberships, current tenant context |
| GET | /health | DB check |

## Platform (super-admin)
`GET /platform/stats`, `GET /platform/institutions`, `PATCH /platform/institutions/:id/status`, `PUT /platform/institutions/:id/subscription`, `GET /platform/plans`, `GET /platform/audit`

## Tenant (`/api/t`)

| Area | Endpoints |
|---|---|
| Institution | `GET/PATCH /institution/current`, `PATCH /institution/current/settings`, `POST /institution/current/branches`, `GET /institution/current/audit`, `GET /institution/current/export` |
| Users & roles | `GET/POST /users`, `PATCH /users/:membershipId`, `POST /users/:membershipId/reset-password`, `GET /roles`, `GET /roles/permissions`, `POST /roles`, `PUT/DELETE /roles/:id` |
| Academic (CRUD: GET list, GET :id, POST, PATCH :id, DELETE :id) | `/academic/years`, `/terms`, `/departments`, `/programmes`, `/class-levels`, `/sections`, `/subjects`, `/offerings`, `/periods`, `/rooms`, `/calendar` |
| Students | `GET/POST /students`, `GET/PATCH/DELETE /students/:id`, `POST /students/:id/status`, `POST /students/:id/enrolment`, `POST /students/promote`, `POST /students/:id/login`, `GET /students/:id/id-card`, `POST /students/:id/id-card/reissue`, `GET /students/import/template`, `POST /students/import?mode=preview\|commit` (multipart `file`), `GET /students/duplicates` |
| Guardians | `GET/POST /guardians`, `PATCH /guardians/:id`, `POST /guardians/:id/links`, `DELETE /guardians/:id/links/:studentId`, `POST /guardians/:id/login` |
| Staff | `GET/POST /staff`, `GET/PATCH/DELETE /staff/:id`, `GET/POST /staff/leave/requests`, `POST /staff/leave/requests/:id/review` |
| Timetable | `GET /timetable?sectionId\|staffId\|roomId`, `POST /timetable/check`, `POST /timetable/entries`, `PATCH/DELETE /timetable/entries/:id`, `GET /timetable/conflicts` |
| Attendance | `GET/PUT /attendance/policy`, `GET /attendance/today`, `POST /attendance/sessions`, `GET /attendance/sessions`, `GET /attendance/sessions/:id`, `PUT /attendance/sessions/:id/records`, `POST /attendance/sessions/:id/submit`, `POST /attendance/sessions/:id/cancel`, `PATCH /attendance/records/:id`, `GET /attendance/records/:id/history`, `POST/GET /attendance/correction-requests`, `POST /attendance/correction-requests/:id/review`, `GET /attendance/students/:id/summary`, `GET /attendance/students/:id/records`, `POST /attendance/sync` |
| QR | `POST /attendance/qr/sessions`, `GET /attendance/qr/sessions/:id/token`, `POST /attendance/qr/sessions/:id/close`, `POST /attendance/qr/scan` |
| Analytics | `GET /analytics/overview`, `/analytics/at-risk`, `/analytics/compliance`, `/analytics/subjects` |
| Reports | `GET /reports/students`, `/reports/monthly-register`, `/reports/daily-register`, `/reports/consecutive-absences`, `/reports/compliance` |
| Leave | `GET /leave/types`, `GET/POST /leave/requests`, `POST /leave/requests/:id/review`, `POST /leave/requests/:id/cancel` |
| Communication | `GET /notifications`, `POST /notifications/read`, `GET/PUT /notifications/preferences`, `GET /notifications/delivery`, `GET/POST /announcements`, `DELETE /announcements/:id`, `POST /announcements/:id/read` |
| Portal | `GET /me/students` |
| AI | `GET /ai/status`, `POST /ai/assistant`, `GET /ai/insights/attendance-drops`, `GET /ai/insights/data-quality` |
| Devices & campus | `GET/POST /devices`, `PATCH /devices/:id`, `POST /devices/:id/rotate-key`, `GET /devices/adapters`, `GET/POST /devices/cards`, `POST /devices/cards/:id/status`, `GET/POST /devices/campus/events`, `GET /devices/campus/summary`, `GET/POST /devices/visitors`, `POST /devices/visitors/:id/checkout` |
| Exams | `GET/POST /exams`, `POST /exams/:id/compute`, `GET /exams/:id/eligibility`, `POST /exams/:id/eligibility/:studentId/exempt`, `POST /exams/:id/eligibility/confirm` |

## Device ingest
`POST /api/device/events` with header `X-Device-Key`. Body (generic-json adapter):
```json
{ "events": [ { "eventId": "r1-000123", "cardUid": "04A2B9", "direction": "in", "occurredAt": "2026-11-26T03:31:00Z" } ] }
```
The response is `{ received, stored, duplicates, unresolved }`. Resending the same `eventId` is safe.
