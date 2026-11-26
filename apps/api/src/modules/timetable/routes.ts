import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import { timetableEntries, courseOfferings, periods, rooms, subjects, sections, classLevels, staff, academicYears, studentEnrolments } from '../../db/schema/index.js';
import { parse, uuidParam, isoDate } from '../../lib/http.js';
import { AppError, notFound } from '../../lib/errors.js';
import { auditReq } from '../../lib/audit.js';
import { assertOwned } from '../../lib/tenant-crud.js';
import { requirePermission } from '../../middleware/auth.js';
import { findConflicts, type Slot } from './conflicts.js';

export const timetableRouter = Router();

async function slotsForYear(conn: DbOrTx, inst: string, yearId: string): Promise<(Slot & { id: string })[]> {
  const rows = await conn.select({ id: timetableEntries.id, dayOfWeek: timetableEntries.dayOfWeek, periodId: timetableEntries.periodId, roomId: timetableEntries.roomId, staffId: courseOfferings.staffId, sectionId: courseOfferings.sectionId, offeringId: courseOfferings.id, effectiveFrom: timetableEntries.effectiveFrom, effectiveTo: timetableEntries.effectiveTo })
    .from(timetableEntries).innerJoin(courseOfferings, eq(courseOfferings.id, timetableEntries.courseOfferingId))
    .where(and(eq(timetableEntries.institutionId, inst), eq(timetableEntries.academicYearId, yearId)));
  return rows;
}

timetableRouter.get('/', requirePermission('timetable.read', 'timetable.manage'), async (req, res) => {
  const q = parse(z.object({ sectionId: z.string().uuid().optional(), staffId: z.string().uuid().optional(), roomId: z.string().uuid().optional(), academicYearId: z.string().uuid().optional() }), req.query);
  const inst = req.ctx!.institutionId;
  let yearId = q.academicYearId;
  if (!yearId) yearId = (await db.select({ id: academicYears.id }).from(academicYears).where(and(eq(academicYears.institutionId, inst), eq(academicYears.isCurrent, true))))[0]?.id;
  // Self-service users only get their own timetable.
  const selfOnly = !req.ctx!.permissions.has('timetable.manage') && !req.ctx!.permissions.has('academic.read');
  const staffFilter = selfOnly ? null : q.staffId;
  let sectionFilter = q.sectionId;
  if (selfOnly && req.ctx!.studentId) {
    const [en] = await db.select({ sectionId: studentEnrolments.sectionId }).from(studentEnrolments).where(and(eq(studentEnrolments.studentId, req.ctx!.studentId), eq(studentEnrolments.isActive, true))).limit(1);
    sectionFilter = en?.sectionId;
    if (!sectionFilter) return res.json({ data: { periods: [], entries: [] } });
  }
  if (!yearId) return res.json({ data: { periods: [], entries: [] } });
  const ps = await db.select().from(periods).where(eq(periods.institutionId, inst)).orderBy(asc(periods.ordinal));
  const entries = await db.select({
    id: timetableEntries.id, dayOfWeek: timetableEntries.dayOfWeek, periodId: timetableEntries.periodId, roomId: timetableEntries.roomId, roomName: rooms.name,
    offeringId: courseOfferings.id, subjectName: subjects.name, subjectCode: subjects.code, subjectKind: subjects.kind, staffId: staff.id, staffName: staff.fullName,
    sectionId: sections.id, sectionName: sections.name, classLevelName: classLevels.name, effectiveFrom: timetableEntries.effectiveFrom, effectiveTo: timetableEntries.effectiveTo,
  }).from(timetableEntries)
    .innerJoin(courseOfferings, eq(courseOfferings.id, timetableEntries.courseOfferingId)).innerJoin(subjects, eq(subjects.id, courseOfferings.subjectId))
    .leftJoin(staff, eq(staff.id, courseOfferings.staffId)).leftJoin(sections, eq(sections.id, courseOfferings.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId)).leftJoin(rooms, eq(rooms.id, timetableEntries.roomId))
    .where(and(eq(timetableEntries.institutionId, inst), eq(timetableEntries.academicYearId, yearId),
      sectionFilter ? eq(courseOfferings.sectionId, sectionFilter) : undefined, staffFilter ? eq(courseOfferings.staffId, staffFilter) : undefined, q.roomId ? eq(timetableEntries.roomId, q.roomId) : undefined,
      selfOnly && req.ctx!.staffId && !req.ctx!.studentId ? eq(courseOfferings.staffId, req.ctx!.staffId) : undefined));
  res.json({ data: { periods: ps, entries } });
});

const entrySchema = z.object({
  courseOfferingId: z.string().uuid(), dayOfWeek: z.number().int().min(1).max(7), periodId: z.string().uuid(), roomId: z.string().uuid().nullable().optional(),
  effectiveFrom: isoDate.nullable().optional(), effectiveTo: isoDate.nullable().optional(),
});

async function checkAndBuild(conn: DbOrTx, inst: string, body: z.infer<typeof entrySchema>, id?: string) {
  await assertOwned(conn, inst, [[courseOfferings, body.courseOfferingId], [periods, body.periodId], [rooms, body.roomId]]);
  const [o] = await conn.select().from(courseOfferings).where(eq(courseOfferings.id, body.courseOfferingId));
  const [p] = await conn.select().from(periods).where(eq(periods.id, body.periodId));
  if (p.isBreak) throw new AppError(400, 'BREAK_PERIOD', 'Classes cannot be scheduled in a break');
  const conflicts = findConflicts({ id, dayOfWeek: body.dayOfWeek, periodId: body.periodId, staffId: o.staffId, sectionId: o.sectionId, roomId: body.roomId ?? null, offeringId: o.id, effectiveFrom: body.effectiveFrom, effectiveTo: body.effectiveTo }, await slotsForYear(conn, inst, o.academicYearId));
  return { offering: o, conflicts };
}

timetableRouter.post('/check', requirePermission('timetable.manage'), async (req, res) => {
  const body = parse(entrySchema.extend({ id: z.string().uuid().optional() }), req.body);
  const { conflicts } = await checkAndBuild(db, req.ctx!.institutionId, body, body.id);
  res.json({ data: { conflicts } });
});

timetableRouter.post('/entries', requirePermission('timetable.manage'), async (req, res) => {
  const body = parse(entrySchema, req.body);
  const inst = req.ctx!.institutionId;
  const row = await db.transaction(async (tx) => {
    const { offering, conflicts } = await checkAndBuild(tx, inst, body);
    if (conflicts.length) throw new AppError(409, 'TIMETABLE_CONFLICT', conflicts.map((c) => c.message).join('; '), conflicts);
    const [e] = await tx.insert(timetableEntries).values({ ...body, institutionId: inst, academicYearId: offering.academicYearId }).returning();
    await auditReq(tx, req, { action: 'timetable_entry.created', entityType: 'timetable_entry', entityId: e.id, after: e });
    return e;
  });
  res.status(201).json({ data: row });
});

/** Move an entry (drag-and-drop). */
timetableRouter.patch('/entries/:id', requirePermission('timetable.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const inst = req.ctx!.institutionId;
  const [before] = await db.select().from(timetableEntries).where(and(eq(timetableEntries.id, id), eq(timetableEntries.institutionId, inst)));
  if (!before) throw notFound('Timetable entry');
  const patch = parse(entrySchema.partial(), req.body);
  const merged = { courseOfferingId: before.courseOfferingId, dayOfWeek: before.dayOfWeek, periodId: before.periodId, roomId: before.roomId, effectiveFrom: before.effectiveFrom, effectiveTo: before.effectiveTo, ...patch };
  const row = await db.transaction(async (tx) => {
    const { conflicts } = await checkAndBuild(tx, inst, merged, id);
    if (conflicts.length) throw new AppError(409, 'TIMETABLE_CONFLICT', conflicts.map((c) => c.message).join('; '), conflicts);
    const [after] = await tx.update(timetableEntries).set({ ...merged, updatedAt: new Date() }).where(eq(timetableEntries.id, id)).returning();
    await auditReq(tx, req, { action: 'timetable_entry.updated', entityType: 'timetable_entry', entityId: id, before, after });
    return after;
  });
  res.json({ data: row });
});

timetableRouter.delete('/entries/:id', requirePermission('timetable.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const [e] = await db.delete(timetableEntries).where(and(eq(timetableEntries.id, id), eq(timetableEntries.institutionId, req.ctx!.institutionId))).returning();
  if (!e) throw notFound('Timetable entry');
  await auditReq(db, req, { action: 'timetable_entry.deleted', entityType: 'timetable_entry', entityId: id, before: e });
  res.json({ data: { ok: true } });
});

/** Scan the whole timetable for existing conflicts (e.g. after bulk edits). */
timetableRouter.get('/conflicts', requirePermission('timetable.manage', 'timetable.read'), async (req, res) => {
  const inst = req.ctx!.institutionId;
  const [y] = await db.select().from(academicYears).where(and(eq(academicYears.institutionId, inst), eq(academicYears.isCurrent, true)));
  if (!y) return res.json({ data: [] });
  const slots = await slotsForYear(db, inst, y.id);
  const seen = new Set<string>();
  const out = [];
  for (const s of slots) {
    for (const c of findConflicts({ ...s, offeringId: undefined }, slots)) {
      const key = [s.id, c.withEntryId].sort().join('|') + c.kind;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ entryId: s.id, ...c });
    }
  }
  res.json({ data: out });
});
