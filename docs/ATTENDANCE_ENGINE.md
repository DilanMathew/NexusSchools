# Attendance engine

Source: `apps/api/src/modules/attendance/engine.ts` (pure functions, unit-tested in `tests/engine.test.ts`).

## Formula

```
percentage = Σ weight(record) / count(records whose weight is not null) × 100
```

`weight` comes from the institution's policy:

| Status | Weight |
|---|---|
| present | 1 |
| absent | 0 |
| late | `lateWeight` (default 1) |
| half_day | `halfDayWeight` (default 0.5) |
| on_duty | 1 if `onDutyCountsAsPresent`, else excluded |
| on_leave / medical_leave / excused | per `approvedLeaveHandling` / `medicalLeaveHandling` / `excusedHandling`: `exclude` (not counted), `present` (1) or `absent` (0) |
| holiday | excluded when `excludeHolidays` |
| not_applicable, pending_verification | always excluded |

Only **submitted or locked** sessions count. Open drafts and cancelled sessions never affect percentages.

**Calculation unit.** `session` counts each session. `day` collapses all of a student's sessions on a date into one day, weighted by the mean of that day's weights. Subject-wise figures are always per session.

**Lab and theory.** When `separateLabAndTheory` is on, summaries also report separate lab and theory buckets.

## Eligibility indicators

- `band`: `shortage` below `eligibilityThreshold`, `warning` below `warningThreshold`, otherwise `eligible`.
- `sessionsNeeded(a, c, t)`: the smallest n with (a+n)/(c+n) ≥ t, i.e. how many sessions in a row the student must attend. Returns `null` if t = 100% and any session was missed.
- `maxMissable(a, c, t)`: the largest m with a/(c+m) ≥ t.

These are indicators only. The official exam decision is a separate, audited action (see the exams module).

## Reproducibility

Policies are versioned. Every update increments `version` and the audit log stores the before and after values. Reports, the portal and exam computations return or store the `policySnapshot` they used.

## Workflow guarantees

- **Submit** runs in a transaction. It locks the session row, validates every mark against the roster and the enabled statuses, requires every roster student to be marked, and then notifies guardians.
- **Deadline.** Teachers cannot submit after the session start plus `submissionDeadlineMinutes`. Holders of `attendance.take.any` can.
- **After submission**, changes go through `PATCH /attendance/records/:id`. That needs a reason, uses optimistic versioning (`expectedVersion`), and writes `attendance_corrections`. Teachers can edit only within `teacherEditWindowMinutes`; after that they need `attendance.correct` or an approved correction request.
- **Offline sync** never overwrites a session that someone else submitted online; the conflict is reported back. A client timestamp in the future or on the wrong date is flagged `requires_verification`.
- **QR** tokens are HMAC-signed with rotating windows; the current and previous window are accepted. A scan is bound to the authenticated student and allowed once. Repeated scans from one network are flagged. The teacher still reviews and submits.
