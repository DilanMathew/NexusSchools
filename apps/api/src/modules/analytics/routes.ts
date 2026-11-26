import { Router } from 'express';
import { z } from 'zod';
import { and, asc, count, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  students, attendanceSessions, attendanceRecords, sections, classLevels, departments, courseOfferings, subjects, staff, studentEnrolments,
  timetableEntries, studentLeaveRequests, attendanceCorrectionRequests, calendarEvents, institutionSettings, academicYears, auditLogs, users,
} from '../../db/schema/index.js';
import { parse, isoDate } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { addDays, eachDate, isoWeekday, todayIn } from '../../lib/dates.js';
import { attendanceScope } from '../attendance/scope.js';
import { asPolicyInput, getDefaultPolicy } from '../attendance/service.js';
import { band, maxMissable, pctFromCounts, policySnapshot, sessionsNeeded } from '../attendance/engine.js';
import { countedSessions, groupedStatusCounts, sessionScopeFilter } from './queries.js';

export const analyticsRouter = Router();
const rangeSchema = z.object({ from: isoDate.optional(), to: isoDate.optional(), date: isoDate.optional() });

analyticsRouter.get('/overview', requirePermission('analytics.read', 'attendance.read.department', 'attendance.read.assigned'), async (req, res) => {
  const ctx = req.ctx!;
  const q = parse(rangeSchema, req.query);
  const today = q.date ?? todayIn(ctx.timezone);
  const from = q.from ?? addDays(today, -29);
  const policy = await getDefaultPolicy(ctx.institutionId);
  const p = asPolicyInput(policy);
  const scope = await attendanceScope(ctx);
  const sf = sessionScopeFilter(scope);

  const [{ totalStudents }] = await db.select({ totalStudents: count() }).from(students).where(and(eq(students.institutionId, ctx.institutionId), eq(students.status, 'active'), isNull(students.deletedAt)));

  // Today: distinct students by their "worst" status for the day.
  const todayRows = await db.select({ studentId: attendanceRecords.studentId, statuses: sql<string[]>`array_agg(distinct ${attendanceRecords.status}::text)::text[]` })
    .from(attendanceRecords).innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
    .where(and(countedSessions(ctx.institutionId, today, today), sf)).groupBy(attendanceRecords.studentId);
  const todayCounts = { marked: todayRows.length, present: 0, absent: 0, late: 0, onLeave: 0 };
  for (const r of todayRows) {
    if (r.statuses.every((s) => s === 'absent')) todayCounts.absent++;
    else if (r.statuses.some((s) => ['on_leave', 'medical_leave'].includes(s)) && !r.statuses.some((s) => ['present', 'late'].includes(s))) todayCounts.onLeave++;
    else if (r.statuses.includes('late')) { todayCounts.late++; todayCounts.present++; } else todayCounts.present++;
  }
  const todayStatus = await groupedStatusCounts(sql`1`, and(countedSessions(ctx.institutionId, today, today), sf));

  const daily = await groupedStatusCounts(sql`${attendanceSessions.sessionDate}`, and(countedSessions(ctx.institutionId, from, today), sf));
  const trend = eachDate(from, today).filter((d) => daily.has(d)).map((d) => ({ date: d, ...pctFromCounts(daily.get(d)!, p) }));

  const bySection = await groupedStatusCounts(sql`${attendanceSessions.sectionId}`, and(countedSessions(ctx.institutionId, from, today), sf));
  const secMeta = bySection.size ? await db.select({ id: sections.id, name: sections.name, level: classLevels.name, ordinal: classLevels.ordinal, dept: departments.name }).from(sections).innerJoin(classLevels, eq(classLevels.id, sections.classLevelId)).leftJoin(departments, eq(departments.id, sections.departmentId)).where(inArray(sections.id, [...bySection.keys()])) : [];
  const sectionStats = secMeta.map((s) => ({ sectionId: s.id, label: `${s.level} ${s.name}`, department: s.dept, ordinal: s.ordinal, ...pctFromCounts(bySection.get(s.id)!, p) })).sort((a, b) => a.ordinal - b.ordinal || a.label.localeCompare(b.label));

  const deptMap = new Map<string, Record<string, number>>();
  for (const s of secMeta) {
    if (!s.dept) continue;
    const acc = deptMap.get(s.dept) ?? {};
    for (const [k, v] of Object.entries(bySection.get(s.id)!)) acc[k] = (acc[k] ?? 0) + (v as number);
    deptMap.set(s.dept, acc);
  }
  const departmentStats = [...deptMap.entries()].map(([name, c]) => ({ name, ...pctFromCounts(c as never, p) }));

  const [{ pendingLeave }] = await db.select({ pendingLeave: count() }).from(studentLeaveRequests).where(and(eq(studentLeaveRequests.institutionId, ctx.institutionId), eq(studentLeaveRequests.status, 'pending')));
  const [{ pendingCorrections }] = await db.select({ pendingCorrections: count() }).from(attendanceCorrectionRequests).where(and(eq(attendanceCorrectionRequests.institutionId, ctx.institutionId), eq(attendanceCorrectionRequests.status, 'pending')));
  const compliance = await submissionCompliance(ctx.institutionId, today, today);
  const recent = await db.select({ action: auditLogs.action, entityType: auditLogs.entityType, createdAt: auditLogs.createdAt, actor: users.fullName }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(eq(auditLogs.institutionId, ctx.institutionId)).orderBy(sql`${auditLogs.createdAt} desc`).limit(8);

  res.json({ data: {
    date: today, range: { from, to: today }, policy: policySnapshot(p), scope: scope.all ? 'institution' : 'limited',
    totalStudents, today: { ...todayCounts, ...pctFromCounts(todayStatus.get('1') ?? {}, p) },
    periodAverage: pctFromCounts([...daily.values()].reduce((a, c) => { for (const [k, v] of Object.entries(c)) a[k] = (a[k] ?? 0) + (v as number); return a; }, {} as Record<string, number>) as never, p),
    trend, sections: sectionStats, departments: departmentStats,
    pending: { leave: pendingLeave, corrections: pendingCorrections, submissions: compliance.totals.pending },
    recentActivity: recent,
  } });
});

/** Students below thresholds over a range. Rule-based and explainable: shows the numbers behind each flag. */
analyticsRouter.get('/at-risk', requirePermission('ai.risk.read', 'analytics.read'), async (req, res) => {
  const ctx = req.ctx!;
  const q = parse(rangeSchema.extend({ sectionId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
  const [year] = await db.select().from(academicYears).where(and(eq(academicYears.institutionId, ctx.institutionId), eq(academicYears.isCurrent, true)));
  const from = q.from ?? year?.startDate;
  const to = q.to ?? todayIn(ctx.timezone);
  const policy = await getDefaultPolicy(ctx.institutionId);
  const p = asPolicyInput(policy);
  const scope = await attendanceScope(ctx);
  const counts = await groupedStatusCounts(sql`${attendanceRecords.studentId}`, and(countedSessions(ctx.institutionId, from, to), sessionScopeFilter(scope), q.sectionId ? eq(attendanceSessions.sectionId, q.sectionId) : undefined));
  const threshold = Number(policy.eligibilityThreshold);
  const rows = [...counts.entries()].map(([studentId, c]) => {
    const s = pctFromCounts(c, p);
    return { studentId, ...s, band: band(s.percentage, p), sessionsNeeded: sessionsNeeded(s.attended, s.conducted, threshold), maxMissable: maxMissable(s.attended, s.conducted, threshold), absent: c.absent ?? 0, late: c.late ?? 0 };
  }).filter((r) => r.band === 'shortage' || r.band === 'warning').sort((a, b) => (a.percentage ?? 0) - (b.percentage ?? 0)).slice(0, q.limit);
  const meta = rows.length ? await db.select({ id: students.id, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, admissionNumber: students.admissionNumber, section: sections.name, level: classLevels.name })
    .from(students).leftJoin(studentEnrolments, and(eq(studentEnrolments.studentId, students.id), eq(studentEnrolments.isActive, true))).leftJoin(sections, eq(sections.id, studentEnrolments.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId))
    .where(inArray(students.id, rows.map((r) => r.studentId))) : [];
  res.json({ data: rows.map((r) => {
    const m = meta.find((x) => x.id === r.studentId);
    return { ...r, name: m?.name, admissionNumber: m?.admissionNumber, classLabel: m ? `${m.level ?? ''} ${m.section ?? ''}`.trim() : null,
      explanation: `${r.attended} of ${r.conducted} counted sessions attended (${r.percentage}%), below the ${r.band === 'shortage' ? 'eligibility' : 'warning'} threshold of ${r.band === 'shortage' ? policy.eligibilityThreshold : policy.warningThreshold}%. ${r.sessionsNeeded ? `Needs ${r.sessionsNeeded} consecutive attended sessions to reach ${threshold}%.` : ''}`.trim() };
  }), meta: { from, to, policy: policySnapshot(p), method: 'rule-based threshold analysis' } });
});

export async function submissionCompliance(inst: string, from: string, to: string) {
  const [settings] = await db.select().from(institutionSettings).where(eq(institutionSettings.institutionId, inst));
  const holidays = await db.select().from(calendarEvents).where(and(eq(calendarEvents.institutionId, inst), inArray(calendarEvents.kind, ['holiday', 'vacation']), lte(calendarEvents.startDate, to), gte(calendarEvents.endDate, from), isNull(calendarEvents.departmentId)));
  const isOff = (d: string) => !(settings?.workingDays ?? [1, 2, 3, 4, 5, 6]).includes(isoWeekday(d)) || holidays.some((h) => h.startDate <= d && h.endDate >= d);
  if (settings?.modules?.dailyAttendance && !settings?.modules?.periodAttendance) return dailyCompliance(inst, from, to, isOff);
  const entries = await db.select({ entryId: timetableEntries.id, dow: timetableEntries.dayOfWeek, periodId: timetableEntries.periodId, offeringId: courseOfferings.id, staffId: staff.id, staffName: staff.fullName, subject: subjects.name, ef: timetableEntries.effectiveFrom, et: timetableEntries.effectiveTo })
    .from(timetableEntries).innerJoin(courseOfferings, eq(courseOfferings.id, timetableEntries.courseOfferingId)).innerJoin(subjects, eq(subjects.id, courseOfferings.subjectId)).leftJoin(staff, eq(staff.id, courseOfferings.staffId))
    .innerJoin(academicYears, and(eq(academicYears.id, timetableEntries.academicYearId), eq(academicYears.isCurrent, true)))
    .where(eq(timetableEntries.institutionId, inst));
  const sess = await db.select({ offeringId: attendanceSessions.courseOfferingId, periodId: attendanceSessions.periodId, date: attendanceSessions.sessionDate, status: attendanceSessions.status })
    .from(attendanceSessions).where(and(eq(attendanceSessions.institutionId, inst), gte(attendanceSessions.sessionDate, from), lte(attendanceSessions.sessionDate, to), sql`${attendanceSessions.courseOfferingId} is not null`));
  const key = (o: string | null, pId: string | null, d: string) => `${o}|${pId}|${d}`;
  const sm = new Map(sess.map((s) => [key(s.offeringId, s.periodId, s.date), s.status]));
  const byStaff = new Map<string, { staffId: string | null; staffName: string; expected: number; submitted: number; pending: number; cancelled: number; missing: { date: string; subject: string }[] }>();
  for (const d of eachDate(from, to)) {
    if (isOff(d)) continue;
    const dow = isoWeekday(d);
    for (const e of entries) {
      if (e.dow !== dow || (e.ef && e.ef > d) || (e.et && e.et < d)) continue;
      const k = e.staffId ?? 'unassigned';
      const acc = byStaff.get(k) ?? { staffId: e.staffId, staffName: e.staffName ?? 'Unassigned', expected: 0, submitted: 0, pending: 0, cancelled: 0, missing: [] };
      const st = sm.get(key(e.offeringId, e.periodId, d));
      if (st === 'cancelled') acc.cancelled++;
      else { acc.expected++; if (st === 'submitted' || st === 'locked') acc.submitted++; else { acc.pending++; if (acc.missing.length < 20) acc.missing.push({ date: d, subject: e.subject }); } }
      byStaff.set(k, acc);
    }
  }
  const rows = [...byStaff.values()].map((r) => ({ ...r, complianceRate: r.expected ? Math.round((r.submitted / r.expected) * 10000) / 100 : null })).sort((a, b) => (a.complianceRate ?? 100) - (b.complianceRate ?? 100));
  const totals = rows.reduce((a, r) => ({ expected: a.expected + r.expected, submitted: a.submitted + r.submitted, pending: a.pending + r.pending }), { expected: 0, submitted: 0, pending: 0 });
  return { from, to, totals, staff: rows };
}

/** Daily-register institutions: one register expected per section per working day, owed by the class teacher. */
async function dailyCompliance(inst: string, from: string, to: string, isOff: (d: string) => boolean) {
  const secs = await db.select({ id: sections.id, name: sections.name, level: classLevels.name, staffId: staff.id, staffName: staff.fullName }).from(sections)
    .innerJoin(classLevels, eq(classLevels.id, sections.classLevelId)).innerJoin(academicYears, and(eq(academicYears.id, sections.academicYearId), eq(academicYears.isCurrent, true)))
    .leftJoin(staff, eq(staff.id, sections.classTeacherStaffId)).where(eq(sections.institutionId, inst));
  const sess = await db.select({ sectionId: attendanceSessions.sectionId, date: attendanceSessions.sessionDate, status: attendanceSessions.status }).from(attendanceSessions)
    .where(and(eq(attendanceSessions.institutionId, inst), eq(attendanceSessions.kind, 'daily'), gte(attendanceSessions.sessionDate, from), lte(attendanceSessions.sessionDate, to)));
  const sm = new Map(sess.map((s) => [`${s.sectionId}|${s.date}`, s.status]));
  const byStaff = new Map<string, { staffId: string | null; staffName: string; expected: number; submitted: number; pending: number; cancelled: number; missing: { date: string; subject: string }[] }>();
  for (const d of eachDate(from, to)) {
    if (isOff(d)) continue;
    for (const s of secs) {
      const k = s.staffId ?? 'unassigned';
      const acc = byStaff.get(k) ?? { staffId: s.staffId, staffName: s.staffName ?? 'Unassigned', expected: 0, submitted: 0, pending: 0, cancelled: 0, missing: [] };
      const st = sm.get(`${s.id}|${d}`);
      if (st === 'cancelled') acc.cancelled++;
      else { acc.expected++; if (st === 'submitted' || st === 'locked') acc.submitted++; else { acc.pending++; if (acc.missing.length < 20) acc.missing.push({ date: d, subject: `Daily register ${s.level} ${s.name}` }); } }
      byStaff.set(k, acc);
    }
  }
  const rows = [...byStaff.values()].map((r) => ({ ...r, complianceRate: r.expected ? Math.round((r.submitted / r.expected) * 10000) / 100 : null })).sort((a, b) => (a.complianceRate ?? 100) - (b.complianceRate ?? 100));
  const totals = rows.reduce((a, r) => ({ expected: a.expected + r.expected, submitted: a.submitted + r.submitted, pending: a.pending + r.pending }), { expected: 0, submitted: 0, pending: 0 });
  return { from, to, totals, staff: rows, mode: 'daily' as const };
}

analyticsRouter.get('/compliance', requirePermission('analytics.read', 'reports.read'), async (req, res) => {
  const ctx = req.ctx!;
  const q = parse(rangeSchema, req.query);
  const to = q.to ?? todayIn(ctx.timezone);
  res.json({ data: await submissionCompliance(ctx.institutionId, q.from ?? addDays(to, -6), to) });
});

/** Subject-wise averages for an offering set within scope. */
analyticsRouter.get('/subjects', requirePermission('analytics.read', 'attendance.read.department', 'attendance.read.assigned'), async (req, res) => {
  const ctx = req.ctx!;
  const q = parse(rangeSchema, req.query);
  const to = q.to ?? todayIn(ctx.timezone);
  const from = q.from ?? addDays(to, -29);
  const p = asPolicyInput(await getDefaultPolicy(ctx.institutionId));
  const scope = await attendanceScope(ctx);
  const c = await groupedStatusCounts(sql`${attendanceSessions.courseOfferingId}`, and(countedSessions(ctx.institutionId, from, to), sessionScopeFilter(scope)));
  const meta = c.size ? await db.select({ id: courseOfferings.id, subject: subjects.name, code: subjects.code, kind: subjects.kind, section: sections.name, level: classLevels.name, staffName: staff.fullName })
    .from(courseOfferings).innerJoin(subjects, eq(subjects.id, courseOfferings.subjectId)).leftJoin(sections, eq(sections.id, courseOfferings.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId)).leftJoin(staff, eq(staff.id, courseOfferings.staffId))
    .where(inArray(courseOfferings.id, [...c.keys()])).orderBy(asc(subjects.name)) : [];
  res.json({ data: meta.map((m) => ({ ...m, ...pctFromCounts(c.get(m.id)!, { ...p, calculationUnit: 'session' }) })), meta: { from, to } });
});
void ne;
