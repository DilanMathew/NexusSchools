import { and, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { attendanceRecords, attendanceSessions, courseOfferings, subjects } from '../../db/schema/index.js';
import { asPolicyInput, getDefaultPolicy } from './service.js';
import { consecutiveAbsentDays, eligibilityDetail, policySnapshot, summarize, summarizeByCategory, type RecordInput } from './engine.js';

export interface Range { from?: string; to?: string }

export async function loadStudentRecords(institutionId: string, studentIds: string[], r: Range) {
  if (!studentIds.length) return [];
  return db.select({
    studentId: attendanceRecords.studentId, status: attendanceRecords.status, date: attendanceSessions.sessionDate,
    subjectId: subjects.id, subjectName: subjects.name, subjectCode: subjects.code, category: subjects.kind, offeringId: attendanceSessions.courseOfferingId, kind: attendanceSessions.kind,
  }).from(attendanceRecords)
    .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId))
    .leftJoin(courseOfferings, eq(courseOfferings.id, attendanceSessions.courseOfferingId))
    .leftJoin(subjects, eq(subjects.id, courseOfferings.subjectId))
    .where(and(
      eq(attendanceRecords.institutionId, institutionId), inArray(attendanceRecords.studentId, studentIds),
      // Only submitted/locked sessions count; open drafts and cancelled sessions never affect percentages.
      ne(attendanceSessions.status, 'open'), ne(attendanceSessions.status, 'cancelled'),
      r.from ? gte(attendanceSessions.sessionDate, r.from) : undefined, r.to ? lte(attendanceSessions.sessionDate, r.to) : undefined,
    ));
}

export async function studentSummary(institutionId: string, studentId: string, range: Range) {
  const policy = await getDefaultPolicy(institutionId);
  const p = asPolicyInput(policy);
  const recs = await loadStudentRecords(institutionId, [studentId], range);
  const inputs: RecordInput[] = recs.map((r) => ({ status: r.status, date: r.date, category: r.category ?? 'theory' }));

  const bySubjectMap = new Map<string, { subjectId: string; name: string; code: string; kind: string; recs: RecordInput[] }>();
  for (const r of recs) {
    if (!r.subjectId) continue;
    const e = bySubjectMap.get(r.subjectId) ?? { subjectId: r.subjectId, name: r.subjectName!, code: r.subjectCode!, kind: r.category!, recs: [] };
    e.recs.push({ status: r.status, date: r.date, category: r.category ?? 'theory' });
    bySubjectMap.set(r.subjectId, e);
  }
  // Subject-level figures are always per-session, regardless of the institution-wide unit.
  const sessionPolicy = { ...p, calculationUnit: 'session' };
  const bySubject = [...bySubjectMap.values()].map((s) => ({ subjectId: s.subjectId, name: s.name, code: s.code, kind: s.kind, ...eligibilityDetail(summarize(s.recs, sessionPolicy), p) }))
    .sort((a, b) => (a.percentage ?? 101) - (b.percentage ?? 101));

  const monthly = new Map<string, RecordInput[]>();
  for (const r of inputs) monthly.set(r.date.slice(0, 7), [...(monthly.get(r.date.slice(0, 7)) ?? []), r]);
  const months = [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, rs]) => ({ month, ...summarize(rs, p) }));

  const recent = inputs.filter((r) => r.date >= (inputs.map((x) => x.date).sort().at(-1) ?? '')).length;
  void recent;
  return {
    policy: policySnapshot(p),
    overall: eligibilityDetail(summarize(inputs, p), p),
    categories: summarizeByCategory(inputs, p),
    bySubject,
    monthly: months,
    consecutiveAbsence: consecutiveAbsentDays(inputs),
    lateCount: inputs.filter((r) => r.status === 'late').length,
    range,
    disclaimer: 'Attendance eligibility shown here is an indicator computed from recorded attendance. Official eligibility decisions are made by the institution.',
  };
}
void sql;
