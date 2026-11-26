# AI design

The core platform never depends on AI. Everything below either works without a provider or degrades clearly.

## Rule-based intelligence (always on)

| Feature | Endpoint | Method |
|---|---|---|
| Student risk monitoring | `GET /api/t/analytics/at-risk` | Below-threshold students, each with an explanation: attended, counted, threshold, sessions needed |
| Attendance intelligence | `GET /api/t/ai/insights/attendance-drops` | Compares the last 14 days with the 28 days before; flags drops of 20 points or more |
| Data quality | `GET /api/t/ai/insights/data-quality` | Students without an enrolment or guardian, possible duplicates, sessions awaiting verification, stale open sessions, unassigned offerings and sections |
| Timetable intelligence | `GET /api/t/timetable/conflicts`, `POST /timetable/check` | Faculty, room and section clash detection; faculty workload on the staff screen |

## Institutional assistant (`POST /api/t/ai/assistant`, permission `ai.use`)

- **Tools** (`modules/ai/tools.ts`): `students_below_threshold`, `absent_students_on_date`, `attendance_by_group`, `pending_attendance_submissions`, `consecutive_absences`.
  - All are read-only and run with the caller's tenant and attendance scope (`attendanceScope`).
  - Each returns at most 50 rows plus a summary.
  - Inputs are validated with Zod before running. The assistant has no SQL access and no write access.
- **LLM mode** applies when `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` are set.
  - Messages API manual tool loop, at most 6 turns, with strict tool schemas.
  - Model `AI_MODEL` (default `claude-opus-5-5`) at effort `AI_EFFORT` (default `medium`).
  - Server-side refusal fallback is enabled (`fallbacks: "default"`), and a `refusal` stop reason is handled.
  - The system prompt requires every figure to come from a tool result and forbids speculating about personal circumstances or recommending penalties.
  - The loop runs on your own server, so student data is processed per request and never stored in a hosted agent session.
- **Built-in mode** (no provider): keyword routing to the same tools, with templated answers. The UI labels which mode is active.
- **Controls**:
  - The monthly LLM request cap comes from the plan (`subscription_plans.limits.aiRequestsPerMonth`).
  - There is a per-user rate limit.
  - Every run is logged in `ai_usage_logs` (provider, model, tokens, tool calls, status, error).
  - Platform statistics show 30-day AI usage.
- **Failure handling**: provider errors return a clear "AI unavailable" message; nothing else in the app is affected.

## Not implemented

These AI features from the original spec are not built yet:
- the LLM parent-communication drafting agent (multilingual message drafts)
- LLM daily narrative summaries

The rule-based endpoints above cover the data side of both.
