import { Router } from 'express';
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db, pool } from '../../db/client.js';
import { students, studentEnrolments, attendanceRecords, attendanceSessions, sections, classLevels } from '../../db/schema/index.js';
import { requirePermission } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { addDays, todayIn } from '../../lib/dates.js';
import { attendanceScope } from '../attendance/scope.js';
import { asPolicyInput, getDefaultPolicy } from '../attendance/service.js';
import { pctFromCounts } from '../attendance/engine.js';
import { countedSessions, groupedStatusCounts, sessionScopeFilter } from '../analytics/queries.js';

/**
 * Intelligence layer. Everything here is deterministic and rule-based (no LLM) so it works without an AI
 * provider and every flag carries its numbers. The conversational assistant (LLM + permission-aware tools)
 * is planned for Phase 7 and is reported as unavailable by /status until implemented.
 */
export const aiRouter = Router();

aiRouter.get('/status', (_req, res) => {
  res.json({ data: { ruleBasedInsights: true, assistant: { available: false, reason: 'The conversational assistant is not implemented yet (Phase 7).', providerConfigured: env.AI_PROVIDER !== 'none' && !!env.ANTHROPIC_API_KEY } } });
});

/** Attendance Intelligence: sudden drops — students whose last-14-day rate fell ≥ 20 points vs the prior 28 days. */
aiRouter.get('/insights/attendance-drops', requirePermission('ai.risk.read'), async (req, res) => {
  const ctx = req.ctx!;
  const to = todayIn(ctx.timezone);
  const recentFrom = addDays(to, -13);
  const priorFrom = addDays(to, -41);
  const priorTo = addDays(to, -14);
  const p = asPolicyInput(await getDefaultPolicy(ctx.institutionId));
  const sf = sessionScopeFilter(await attendanceScope(ctx));
  const recent = await groupedStatusCounts(sql`${attendanceRecords.studentId}`, and(countedSessions(ctx.institutionId, recentFrom, to), sf));
  const prior = await groupedStatusCounts(sql`${attendanceRecords.studentId}`, and(countedSessions(ctx.institutionId, priorFrom, priorTo), sf));
  const drops = [];
  for (const [id, c] of recent) {
    const r = pctFromCounts(c, p); const pr = prior.get(id) ? pctFromCounts(prior.get(id)!, p) : null;
    if (r.percentage === null || !pr || pr.percentage === null || r.conducted < 3 || pr.conducted < 5) continue;
    const delta = Math.round((r.percentage - pr.percentage) * 100) / 100;
    if (delta <= -20) drops.push({ studentId: id, recent: r, prior: pr, delta });
  }
  drops.sort((a, b) => a.delta - b.delta);
  const top = drops.slice(0, 50);
  const meta = top.length ? await db.select({ id: students.id, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, admissionNumber: students.admissionNumber, section: sections.name, level: classLevels.name })
    .from(students).leftJoin(studentEnrolments, and(eq(studentEnrolments.studentId, students.id), eq(studentEnrolments.isActive, true))).leftJoin(sections, eq(sections.id, studentEnrolments.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId))
    .where(inArray(students.id, top.map((d) => d.studentId))) : [];
  res.json({ data: top.map((d) => {
    const m = meta.find((x) => x.id === d.studentId);
    return { ...d, name: m?.name, admissionNumber: m?.admissionNumber, classLabel: `${m?.level ?? ''} ${m?.section ?? ''}`.trim(),
      explanation: `Attendance fell from ${d.prior.percentage}% (${priorFrom} – ${priorTo}, ${d.prior.conducted} sessions) to ${d.recent.percentage}% (${recentFrom} – ${to}, ${d.recent.conducted} sessions).`,
      suggestedAction: 'Class teacher follow-up with the student and guardian.' };
  }), meta: { method: 'rule-based: 14-day vs prior-28-day comparison, flag at ≥20 point drop', note: 'Indicators only. Do not use for automated penalties.' } });
});

/** Data Quality checks. */
aiRouter.get('/insights/data-quality', requirePermission('students.manage', 'academic.manage'), async (req, res) => {
  const inst = req.ctx!.institutionId;
  const q = async (text: string) => (await pool.query<{ n: number }>(text, [inst])).rows[0].n;
  const checks = [
    { key: 'students_without_enrolment', label: 'Active students not enrolled in any section this year', count: await q(`select count(*)::int n from students s where s.institution_id=$1 and s.deleted_at is null and s.status='active' and not exists (select 1 from student_enrolments e join academic_years y on y.id=e.academic_year_id and y.is_current where e.student_id=s.id and e.is_active)`) },
    { key: 'students_without_guardian', label: 'Active students with no linked guardian', count: await q(`select count(*)::int n from students s where s.institution_id=$1 and s.deleted_at is null and s.status='active' and not exists (select 1 from student_guardians g where g.student_id=s.id)`) },
    { key: 'possible_duplicates', label: 'Possible duplicate students (same name and date of birth)', count: await q(`select count(*)::int n from (select 1 from students where institution_id=$1 and deleted_at is null group by lower(first_name), lower(last_name), date_of_birth having count(*)>1) x`) },
    { key: 'sessions_need_verification', label: 'Offline-synced sessions flagged for verification', count: await q(`select count(*)::int n from attendance_sessions where institution_id=$1 and requires_verification`) },
    { key: 'stale_open_sessions', label: 'Sessions left open (not submitted) for over 2 days', count: await q(`select count(*)::int n from attendance_sessions where institution_id=$1 and status='open' and session_date < current_date - 2`) },
    { key: 'offerings_without_faculty', label: 'Course offerings with no faculty assigned', count: await q(`select count(*)::int n from course_offerings o join academic_years y on y.id=o.academic_year_id and y.is_current where o.institution_id=$1 and o.staff_id is null`) },
    { key: 'sections_without_class_teacher', label: 'Sections without a class teacher', count: await q(`select count(*)::int n from sections s join academic_years y on y.id=s.academic_year_id and y.is_current where s.institution_id=$1 and s.class_teacher_staff_id is null`) },
  ];
  res.json({ data: checks });
});
void gte; void lte; void isNull; void attendanceSessions;
