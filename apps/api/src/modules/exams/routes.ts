import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { examinations, examEligibility, academicYears, academicTerms, students, studentEnrolments, sections, classLevels, attendanceRecords, attendanceSessions } from '../../db/schema/index.js';
import { parse, uuidParam, isoDate } from '../../lib/http.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { auditReq } from '../../lib/audit.js';
import { assertOwned } from '../../lib/tenant-crud.js';
import { requirePermission } from '../../middleware/auth.js';
import { asPolicyInput, getDefaultPolicy } from '../attendance/service.js';
import { pctFromCounts, policySnapshot, summarize } from '../attendance/engine.js';
import { countedSessions, groupedStatusCounts } from '../analytics/queries.js';
import { toCsv } from '../reports/csv.js';

/**
 * Examination eligibility. Computing produces an attendance-based indicator only; the official decision
 * (confirmed eligible / not eligible) is a separate, audited action by someone holding exams.confirm.
 */
export const examsRouter = Router();

examsRouter.get('/', requirePermission('exams.manage', 'exams.confirm'), async (req, res) => {
  const rows = await db.select({ e: examinations, yearName: academicYears.name,
    total: sql<number>`(select count(*)::int from examination_eligibility x where x.examination_id = "examination_sessions"."id")`,
    belowThreshold: sql<number>`(select count(*)::int from examination_eligibility x where x.examination_id = "examination_sessions"."id" and not x.meets_threshold)`,
    decided: sql<number>`(select count(*)::int from examination_eligibility x where x.examination_id = "examination_sessions"."id" and x.status in ('confirmed_eligible','confirmed_ineligible'))` })
    .from(examinations).innerJoin(academicYears, eq(academicYears.id, examinations.academicYearId)).where(eq(examinations.institutionId, req.ctx!.institutionId)).orderBy(desc(examinations.createdAt));
  res.json({ data: rows.map((r) => ({ ...r.e, yearName: r.yearName, total: r.total, belowThreshold: r.belowThreshold, decided: r.decided })) });
});

examsRouter.post('/', requirePermission('exams.manage'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(3).max(120), academicYearId: z.string().uuid(), termId: z.string().uuid().nullable().optional(), attendanceFrom: isoDate, attendanceTo: isoDate, threshold: z.number().min(0).max(100).optional() }), req.body);
  if (body.attendanceFrom > body.attendanceTo) throw badRequest('Attendance period start must be before its end');
  await assertOwned(db, req.ctx!.institutionId, [[academicYears, body.academicYearId], [academicTerms, body.termId]]);
  const policy = await getDefaultPolicy(req.ctx!.institutionId);
  const [e] = await db.insert(examinations).values({ ...body, institutionId: req.ctx!.institutionId, threshold: String(body.threshold ?? policy.eligibilityThreshold) }).returning();
  await auditReq(db, req, { action: 'exam.created', entityType: 'examination', entityId: e.id, after: e });
  res.status(201).json({ data: e });
});

async function loadExam(inst: string, id: string) {
  const [e] = await db.select().from(examinations).where(and(eq(examinations.id, id), eq(examinations.institutionId, inst)));
  if (!e) throw notFound('Examination');
  return e;
}

/** (Re)compute indicators for every active student in the exam's year. Decided and exempted rows keep their status. */
examsRouter.post('/:id/compute', requirePermission('exams.manage'), async (req, res) => {
  const inst = req.ctx!.institutionId;
  const e = await loadExam(inst, parse(uuidParam, req.params.id));
  const policy = await getDefaultPolicy(inst); const p = asPolicyInput(policy);
  const th = Number(e.threshold);
  const roster = await db.select({ id: students.id }).from(studentEnrolments).innerJoin(students, eq(students.id, studentEnrolments.studentId))
    .where(and(eq(studentEnrolments.academicYearId, e.academicYearId), eq(studentEnrolments.isActive, true), eq(students.status, 'active')));
  let stats: Map<string, { attended: number; conducted: number; percentage: number | null }>;
  if (p.calculationUnit === 'day') {
    const recs = await db.select({ studentId: attendanceRecords.studentId, status: attendanceRecords.status, date: attendanceSessions.sessionDate }).from(attendanceRecords)
      .innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId)).where(and(countedSessions(inst, e.attendanceFrom, e.attendanceTo)));
    const by = new Map<string, { status: typeof recs[number]['status']; date: string }[]>();
    for (const r of recs) by.set(r.studentId, [...(by.get(r.studentId) ?? []), r]);
    stats = new Map([...by.entries()].map(([k, v]) => { const s = summarize(v, p); return [k, { attended: s.attended, conducted: s.conducted, percentage: s.percentage }]; }));
  } else {
    const c = await groupedStatusCounts(sql`${attendanceRecords.studentId}`, countedSessions(inst, e.attendanceFrom, e.attendanceTo));
    stats = new Map([...c.entries()].map(([k, v]) => [k, pctFromCounts(v, p)]));
  }
  const values = roster.map((r) => { const s = stats.get(r.id); return { institutionId: inst, examinationId: e.id, studentId: r.id, percentage: s?.percentage?.toString() ?? null, attended: s?.attended.toString() ?? '0', conducted: s?.conducted.toString() ?? '0', meetsThreshold: s?.percentage !== null && s?.percentage !== undefined && s.percentage >= th }; });
  await db.transaction(async (tx) => {
    for (let i = 0; i < values.length; i += 2000) {
      await tx.insert(examEligibility).values(values.slice(i, i + 2000)).onConflictDoUpdate({
        target: [examEligibility.examinationId, examEligibility.studentId],
        set: { percentage: sql`excluded.percentage`, attended: sql`excluded.attended`, conducted: sql`excluded.conducted`, meetsThreshold: sql`excluded.meets_threshold`, updatedAt: sql`now()` },
      });
    }
    await tx.update(examinations).set({ computedAt: new Date(), policySnapshot: policySnapshot(p), updatedAt: new Date() }).where(eq(examinations.id, e.id));
    await auditReq(tx, req, { action: 'exam.eligibility_computed', entityType: 'examination', entityId: e.id, metadata: { students: values.length, belowThreshold: values.filter((v) => !v.meetsThreshold).length, threshold: th, policyVersion: policy.version } });
  });
  res.json({ data: { students: values.length, meetsThreshold: values.filter((v) => v.meetsThreshold).length, belowThreshold: values.filter((v) => !v.meetsThreshold).length } });
});

examsRouter.get('/:id/eligibility', requirePermission('exams.manage', 'exams.confirm'), async (req, res) => {
  const inst = req.ctx!.institutionId;
  const e = await loadExam(inst, parse(uuidParam, req.params.id));
  const q = parse(z.object({ filter: z.enum(['all', 'below', 'undecided', 'exempted']).default('below'), sectionId: z.string().uuid().optional(), format: z.enum(['json', 'csv']).default('json') }), req.query);
  const rows = await db.select({ x: examEligibility, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, adm: students.admissionNumber, sec: sections.name, lvl: classLevels.name, sectionId: sections.id })
    .from(examEligibility).innerJoin(students, eq(students.id, examEligibility.studentId))
    .leftJoin(studentEnrolments, and(eq(studentEnrolments.studentId, students.id), eq(studentEnrolments.isActive, true), eq(studentEnrolments.academicYearId, e.academicYearId)))
    .leftJoin(sections, eq(sections.id, studentEnrolments.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId))
    .where(and(eq(examEligibility.examinationId, e.id),
      q.filter === 'below' ? eq(examEligibility.meetsThreshold, false) : q.filter === 'undecided' ? inArray(examEligibility.status, ['computed', 'exempted']) : q.filter === 'exempted' ? eq(examEligibility.status, 'exempted') : undefined,
      q.sectionId ? eq(sections.id, q.sectionId) : undefined))
    .orderBy(asc(classLevels.ordinal), asc(sections.name), asc(students.firstName));
  const out = rows.map((r) => ({ ...r.x, percentage: r.x.percentage === null ? null : Number(r.x.percentage), name: r.name, admissionNumber: r.adm, classLabel: `${r.lvl ?? ''} ${r.sec ?? ''}`.trim() }));
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="eligibility-${e.name.replace(/\W+/g, '-')}.csv"`);
    return res.send('﻿' + toCsv(['Admission No', 'Name', 'Class', 'Attendance %', 'Meets threshold', 'Status', 'Exemption reason'], out.map((r) => [r.admissionNumber, r.name, r.classLabel, r.percentage, r.meetsThreshold ? 'Yes' : 'No', r.status, r.exemptionReason]), [`${e.name} — threshold ${e.threshold}% — attendance ${e.attendanceFrom} to ${e.attendanceTo}`]));
  }
  res.json({ data: out, meta: { exam: e } });
});

/** Record an authorised exemption (e.g. medical) against the attendance indicator. */
examsRouter.post('/:id/eligibility/:studentId/exempt', requirePermission('exams.manage'), async (req, res) => {
  const inst = req.ctx!.institutionId;
  const e = await loadExam(inst, parse(uuidParam, req.params.id));
  const studentId = parse(uuidParam, req.params.studentId);
  const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
  const [r] = await db.update(examEligibility).set({ status: 'exempted', exemptionReason: reason, decidedByUserId: req.auth!.userId, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(examEligibility.examinationId, e.id), eq(examEligibility.studentId, studentId), inArray(examEligibility.status, ['computed']))).returning();
  if (!r) throw new AppError(409, 'NOT_EDITABLE', 'Only computed rows can be exempted; confirmed decisions are final.');
  await auditReq(db, req, { action: 'exam.exemption_recorded', entityType: 'examination_eligibility', entityId: r.id, after: { reason } });
  res.json({ data: r });
});

/** Official decision. Separate permission from computing; audited. */
examsRouter.post('/:id/eligibility/confirm', requirePermission('exams.confirm'), async (req, res) => {
  const inst = req.ctx!.institutionId;
  const e = await loadExam(inst, parse(uuidParam, req.params.id));
  const body = parse(z.object({ studentIds: z.array(z.string().uuid()).min(1).max(5000), decision: z.enum(['confirmed_eligible', 'confirmed_ineligible']), note: z.string().max(300).optional() }), req.body);
  const rows = await db.update(examEligibility).set({ status: body.decision, decidedByUserId: req.auth!.userId, decidedAt: new Date(), exemptionReason: sql`coalesce(${examEligibility.exemptionReason}, ${body.note ?? null})`, updatedAt: new Date() })
    .where(and(eq(examEligibility.examinationId, e.id), inArray(examEligibility.studentId, body.studentIds), inArray(examEligibility.status, ['computed', 'exempted']))).returning({ id: examEligibility.id });
  await auditReq(db, req, { action: `exam.${body.decision}`, entityType: 'examination', entityId: e.id, metadata: { count: rows.length, note: body.note } });
  res.json({ data: { updated: rows.length } });
});
