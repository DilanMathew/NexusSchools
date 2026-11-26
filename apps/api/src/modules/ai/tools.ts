/**
 * Read-only, permission-aware data tools shared by the LLM assistant and the built-in question set.
 * Every tool runs inside the caller's tenant and attendance scope; none can write data or run arbitrary SQL.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { attendanceRecords, attendanceSessions, students, studentEnrolments, sections, classLevels, departments, academicYears } from '../../db/schema/index.js';
import type { TenantContext } from '../../types.js';
import { addDays, todayIn } from '../../lib/dates.js';
import { attendanceScope } from '../attendance/scope.js';
import { asPolicyInput, getDefaultPolicy } from '../attendance/service.js';
import { band, consecutiveAbsentDays, pctFromCounts } from '../attendance/engine.js';
import { countedSessions, groupedStatusCounts, sessionScopeFilter } from '../analytics/queries.js';
import { submissionCompliance } from '../analytics/routes.js';
import { forbidden } from '../../lib/errors.js';

const MAX_ROWS = 50;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function studentMeta(ids: string[]) {
  if (!ids.length) return new Map<string, { name: string; admissionNumber: string; classLabel: string }>();
  const rows = await db.select({ id: students.id, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, adm: students.admissionNumber, sec: sections.name, lvl: classLevels.name })
    .from(students).leftJoin(studentEnrolments, and(eq(studentEnrolments.studentId, students.id), eq(studentEnrolments.isActive, true)))
    .leftJoin(sections, eq(sections.id, studentEnrolments.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId))
    .where(inArray(students.id, ids));
  return new Map(rows.map((r) => [r.id, { name: r.name, admissionNumber: r.adm, classLabel: `${r.lvl ?? ''} ${r.sec ?? ''}`.trim() }]));
}

async function sectionIdsMatching(ctx: TenantContext, label?: string) {
  if (!label) return undefined;
  const rows = await db.select({ id: sections.id }).from(sections).innerJoin(classLevels, eq(classLevels.id, sections.classLevelId))
    .where(and(eq(sections.institutionId, ctx.institutionId), sql`(${classLevels.name} || ' ' || ${sections.name}) ILIKE ${'%' + label + '%'} OR ${classLevels.name} ILIKE ${'%' + label + '%'}`));
  return rows.map((r) => r.id);
}

export interface ToolDef<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: I;
  jsonSchema: Record<string, unknown>;
  run: (ctx: TenantContext, input: z.infer<I>) => Promise<{ rows: unknown[]; summary: Record<string, unknown> }>;
}

const def = <I extends z.ZodType>(t: ToolDef<I>) => t;

export const TOOLS = [
  def({
    name: 'students_below_threshold',
    description: 'Students whose attendance percentage is below a threshold over a date range (default: current academic year to today). Uses the institution attendance policy. Optionally filter by class label such as "Grade 10" or "CSE Year III A".',
    input: z.object({ threshold: z.number().min(0).max(100).nullable(), classLabel: z.string().max(60).nullable(), from: isoDate.nullable(), to: isoDate.nullable() }),
    jsonSchema: { type: 'object', additionalProperties: false, required: ['threshold', 'classLabel', 'from', 'to'], properties: { threshold: { type: ['number', 'null'], description: 'Percent; null = institution eligibility threshold' }, classLabel: { type: ['string', 'null'] }, from: { type: ['string', 'null'], description: 'YYYY-MM-DD' }, to: { type: ['string', 'null'], description: 'YYYY-MM-DD' } } },
    run: async (ctx, i) => {
      const policy = await getDefaultPolicy(ctx.institutionId); const p = asPolicyInput(policy);
      const [y] = await db.select().from(academicYears).where(and(eq(academicYears.institutionId, ctx.institutionId), eq(academicYears.isCurrent, true)));
      const to = i.to ?? todayIn(ctx.timezone); const from = i.from ?? y?.startDate ?? addDays(to, -90);
      const th = i.threshold ?? Number(policy.eligibilityThreshold);
      const secIds = await sectionIdsMatching(ctx, i.classLabel ?? undefined);
      const counts = await groupedStatusCounts(sql`${attendanceRecords.studentId}`, and(countedSessions(ctx.institutionId, from, to), sessionScopeFilter(await attendanceScope(ctx)), secIds ? (secIds.length ? inArray(attendanceSessions.sectionId, secIds) : sql`false`) : undefined));
      const all = [...counts.entries()].map(([id, c]) => ({ id, ...pctFromCounts(c, p) })).filter((r) => r.percentage !== null && r.percentage < th).sort((a, b) => a.percentage! - b.percentage!);
      const meta = await studentMeta(all.slice(0, MAX_ROWS).map((r) => r.id));
      return { summary: { from, to, threshold: th, totalMatching: all.length, studentsWithData: counts.size, calculation: `${p.calculationUnit}-based, policy v${policy.version}` },
        rows: all.slice(0, MAX_ROWS).map((r) => ({ ...meta.get(r.id), percentage: r.percentage, attended: r.attended, counted: r.conducted, band: band(r.percentage, p) })) };
    },
  }),
  def({
    name: 'absent_students_on_date',
    description: 'Students marked absent (in every counted session that day) or partially absent on a given date. Default date: today.',
    input: z.object({ date: isoDate.nullable() }),
    jsonSchema: { type: 'object', additionalProperties: false, required: ['date'], properties: { date: { type: ['string', 'null'], description: 'YYYY-MM-DD; null = today' } } },
    run: async (ctx, i) => {
      const date = i.date ?? todayIn(ctx.timezone);
      const rows = await db.select({ studentId: attendanceRecords.studentId, statuses: sql<string[]>`array_agg(${attendanceRecords.status}::text)::text[]` })
        .from(attendanceRecords).innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
        .where(and(countedSessions(ctx.institutionId, date, date), sessionScopeFilter(await attendanceScope(ctx)))).groupBy(attendanceRecords.studentId);
      const abs = rows.filter((r) => r.statuses.includes('absent')).map((r) => ({ id: r.studentId, fullDay: r.statuses.every((s) => s === 'absent'), absentSessions: r.statuses.filter((s) => s === 'absent').length, sessions: r.statuses.length }));
      abs.sort((a, b) => Number(b.fullDay) - Number(a.fullDay) || b.absentSessions - a.absentSessions);
      const meta = await studentMeta(abs.slice(0, MAX_ROWS).map((r) => r.id));
      return { summary: { date, studentsMarked: rows.length, fullDayAbsent: abs.filter((a) => a.fullDay).length, partlyAbsent: abs.filter((a) => !a.fullDay).length }, rows: abs.slice(0, MAX_ROWS).map((a) => ({ ...meta.get(a.id), fullDay: a.fullDay, absentSessions: a.absentSessions, sessions: a.sessions })) };
    },
  }),
  def({
    name: 'attendance_by_group',
    description: 'Attendance percentage grouped by department or by class section over a date range (default: last 30 days).',
    input: z.object({ groupBy: z.enum(['department', 'section']), from: isoDate.nullable(), to: isoDate.nullable() }),
    jsonSchema: { type: 'object', additionalProperties: false, required: ['groupBy', 'from', 'to'], properties: { groupBy: { type: 'string', enum: ['department', 'section'] }, from: { type: ['string', 'null'] }, to: { type: ['string', 'null'] } } },
    run: async (ctx, i) => {
      const p = asPolicyInput(await getDefaultPolicy(ctx.institutionId));
      const to = i.to ?? todayIn(ctx.timezone); const from = i.from ?? addDays(to, -29);
      const c = await groupedStatusCounts(sql`${attendanceSessions.sectionId}`, and(countedSessions(ctx.institutionId, from, to), sessionScopeFilter(await attendanceScope(ctx))));
      const meta = c.size ? await db.select({ id: sections.id, name: sections.name, lvl: classLevels.name, dept: departments.name }).from(sections).innerJoin(classLevels, eq(classLevels.id, sections.classLevelId)).leftJoin(departments, eq(departments.id, sections.departmentId)).where(inArray(sections.id, [...c.keys()])) : [];
      const groups = new Map<string, Record<string, number>>();
      for (const m of meta) {
        const key = i.groupBy === 'department' ? (m.dept ?? 'No department') : `${m.lvl} ${m.name}`;
        const acc = groups.get(key) ?? {};
        for (const [k, v] of Object.entries(c.get(m.id)!)) acc[k] = (acc[k] ?? 0) + (v as number);
        groups.set(key, acc);
      }
      const rows = [...groups.entries()].map(([group, cc]) => ({ group, ...pctFromCounts(cc as never, p) })).sort((a, b) => (a.percentage ?? 0) - (b.percentage ?? 0));
      return { summary: { from, to, groupBy: i.groupBy, groups: rows.length }, rows: rows.slice(0, MAX_ROWS) };
    },
  }),
  def({
    name: 'pending_attendance_submissions',
    description: 'Which faculty have not submitted scheduled attendance, over a date range (default: today).',
    input: z.object({ from: isoDate.nullable(), to: isoDate.nullable() }),
    jsonSchema: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: ['string', 'null'] }, to: { type: ['string', 'null'] } } },
    run: async (ctx, i) => {
      if (!ctx.permissions.has('analytics.read') && !ctx.permissions.has('reports.read')) throw forbidden('Submission compliance needs report access');
      const to = i.to ?? todayIn(ctx.timezone); const from = i.from ?? to;
      const r = await submissionCompliance(ctx.institutionId, from, to);
      return { summary: { from, to, ...r.totals }, rows: r.staff.filter((s) => s.pending > 0).slice(0, MAX_ROWS).map((s) => ({ faculty: s.staffName, pending: s.pending, submitted: s.submitted, expected: s.expected, missing: s.missing.slice(0, 5) })) };
    },
  }),
  def({
    name: 'consecutive_absences',
    description: 'Students currently absent for N or more consecutive counted days (looking back 30 days).',
    input: z.object({ minDays: z.number().int().min(2).max(30) }),
    jsonSchema: { type: 'object', additionalProperties: false, required: ['minDays'], properties: { minDays: { type: 'integer', minimum: 2, maximum: 30 } } },
    run: async (ctx, i) => {
      const to = todayIn(ctx.timezone); const from = addDays(to, -30);
      const recs = await db.select({ studentId: attendanceRecords.studentId, status: attendanceRecords.status, date: attendanceSessions.sessionDate }).from(attendanceRecords).innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
        .where(and(countedSessions(ctx.institutionId, from, to), sessionScopeFilter(await attendanceScope(ctx))));
      const by = new Map<string, typeof recs>();
      for (const r of recs) by.set(r.studentId, [...(by.get(r.studentId) ?? []), r]);
      const hits = [...by.entries()].map(([id, rs]) => ({ id, ...consecutiveAbsentDays(rs) })).filter((h) => h.current >= i.minDays).sort((a, b) => b.current - a.current);
      const meta = await studentMeta(hits.slice(0, MAX_ROWS).map((h) => h.id));
      return { summary: { minDays: i.minDays, matching: hits.length, lookback: `${from} to ${to}` }, rows: hits.slice(0, MAX_ROWS).map((h) => ({ ...meta.get(h.id), consecutiveDays: h.current })) };
    },
  }),
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];
export const toolByName = (n: string) => TOOLS.find((t) => t.name === n);
void isNull;
