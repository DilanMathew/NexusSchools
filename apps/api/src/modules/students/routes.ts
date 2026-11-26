import { Router, type Request } from 'express';
import { z } from 'zod';
import multer from 'multer';
import Papa from 'papaparse';
import QRCode from 'qrcode';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, pool, type DbOrTx } from '../../db/client.js';
import {
  students, studentEnrolments, sections, classLevels, academicYears, studentStatusHistory, guardians, studentGuardians, roles,
  institutions,
} from '../../db/schema/index.js';
import { parse, paginationSchema, pageMeta, uuidParam, isoDate } from '../../lib/http.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { auditReq } from '../../lib/audit.js';
import { can, requirePermission } from '../../middleware/auth.js';
import { assertOwned } from '../../lib/tenant-crud.js';
import { attendanceScope } from '../attendance/scope.js';
import { createOrAttachUser } from '../users/routes.js';

export const studentsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

const baseFields = {
  admissionNumber: z.string().trim().min(1).max(40),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).default(''),
  dateOfBirth: isoDate.nullable().optional(),
  gender: z.string().max(20).nullable().optional(),
  admissionDate: isoDate.nullable().optional(),
  email: z.string().email().max(200).nullable().optional().or(z.literal('').transform(() => null)),
  phone: z.string().max(30).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  emergencyContact: z.object({ name: z.string().max(120).optional(), phone: z.string().max(30).optional(), relationship: z.string().max(40).optional() }).nullable().optional(),
  medicalNotes: z.string().max(2000).nullable().optional(),
  previousInstitution: z.string().max(200).nullable().optional(),
};
const createSchema = z.object({
  ...baseFields,
  enrolment: z.object({ sectionId: z.string().uuid(), rollNumber: z.string().max(20).optional() }).optional(),
  login: z.object({ email: z.string().email(), password: z.string().min(1).max(128) }).optional(),
});
const updateSchema = z.object(baseFields).partial();

/** Strip restricted fields according to permissions. */
function present(req: Request, s: typeof students.$inferSelect) {
  const out: Record<string, unknown> = { ...s };
  delete out.identityToken;
  if (!can(req, 'students.medical.read')) delete out.medicalNotes;
  if (!can(req, 'students.contact.read', 'students.manage')) { delete out.email; delete out.phone; delete out.address; delete out.emergencyContact; }
  return out;
}

async function currentYearId(inst: string, conn: DbOrTx = db) {
  const [y] = await conn.select({ id: academicYears.id }).from(academicYears).where(and(eq(academicYears.institutionId, inst), eq(academicYears.isCurrent, true)));
  return y?.id ?? null;
}

studentsRouter.get('/', requirePermission('students.read'), async (req, res) => {
  const p = parse(paginationSchema.extend({ sectionId: z.string().uuid().optional(), classLevelId: z.string().uuid().optional(), status: z.string().max(20).optional(), academicYearId: z.string().uuid().optional() }), req.query);
  const inst = req.ctx!.institutionId;
  const yearId = p.academicYearId ?? await currentYearId(inst);
  const scope = await attendanceScope(req.ctx!);
  const restrict = !scope.all && !can(req, 'students.manage');
  const where = and(
    eq(students.institutionId, inst), isNull(students.deletedAt),
    p.status ? eq(students.status, p.status as never) : undefined,
    p.search ? sql`(${students.firstName} || ' ' || ${students.lastName} ILIKE ${'%' + p.search + '%'} OR ${students.admissionNumber} ILIKE ${'%' + p.search + '%'})` : undefined,
    p.sectionId ? eq(studentEnrolments.sectionId, p.sectionId) : undefined,
    p.classLevelId ? eq(sections.classLevelId, p.classLevelId) : undefined,
    restrict ? (scope.rosterSectionIds.length ? inArray(studentEnrolments.sectionId, scope.rosterSectionIds) : sql`false`) : undefined,
  );
  const base = () => db.select().from(students)
    .leftJoin(studentEnrolments, and(eq(studentEnrolments.studentId, students.id), eq(studentEnrolments.isActive, true), yearId ? eq(studentEnrolments.academicYearId, yearId) : sql`false`))
    .leftJoin(sections, eq(sections.id, studentEnrolments.sectionId))
    .leftJoin(classLevels, eq(classLevels.id, sections.classLevelId));
  const [{ total }] = await db.select({ total: count() }).from(students)
    .leftJoin(studentEnrolments, and(eq(studentEnrolments.studentId, students.id), eq(studentEnrolments.isActive, true), yearId ? eq(studentEnrolments.academicYearId, yearId) : sql`false`))
    .leftJoin(sections, eq(sections.id, studentEnrolments.sectionId)).where(where);
  const rows = await base().where(where).orderBy(asc(classLevels.ordinal), asc(sections.name), asc(studentEnrolments.rollNumber), asc(students.firstName)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({
    data: rows.map((r) => ({ ...present(req, r.students), enrolment: r.student_enrolments ? { id: r.student_enrolments.id, sectionId: r.student_enrolments.sectionId, rollNumber: r.student_enrolments.rollNumber, sectionName: r.sections?.name, classLevelName: r.class_levels?.name } : null })),
    meta: pageMeta(p, total),
  });
});

studentsRouter.get('/import/template', requirePermission('students.import'), (_req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="student-import-template.csv"');
  res.send('admission_number,first_name,last_name,date_of_birth,gender,admission_date,email,phone,class_level,section,roll_number,guardian_name,guardian_phone,guardian_email,guardian_relationship\nADM1001,Asha,Kumar,2012-05-14,female,2024-06-01,,9876543210,Grade 7,A,1,Ravi Kumar,9876500000,ravi@example.com,father\n');
});

const importRow = z.object({
  admission_number: z.string().trim().min(1, 'admission_number is required').max(40),
  first_name: z.string().trim().min(1, 'first_name is required').max(80),
  last_name: z.string().trim().max(80).optional().default(''),
  date_of_birth: z.union([isoDate, z.literal('')]).optional(),
  gender: z.string().max(20).optional(),
  admission_date: z.union([isoDate, z.literal('')]).optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  phone: z.string().max(30).optional(),
  class_level: z.string().max(60).optional(),
  section: z.string().max(20).optional(),
  roll_number: z.string().max(20).optional(),
  guardian_name: z.string().max(120).optional(),
  guardian_phone: z.string().max(30).optional(),
  guardian_email: z.union([z.string().email(), z.literal('')]).optional(),
  guardian_relationship: z.string().max(40).optional(),
});

/**
 * Bulk import. mode=preview validates and returns valid/invalid/duplicate rows without writing.
 * mode=commit writes all valid rows in one transaction (all-or-nothing).
 */
studentsRouter.post('/import', requirePermission('students.import'), upload.single('file'), async (req, res) => {
  const mode = parse(z.enum(['preview', 'commit']).default('preview'), req.query.mode);
  if (!req.file) throw badRequest('Upload a CSV file in the "file" field');
  const parsed = Papa.parse<Record<string, string>>(req.file.buffer.toString('utf8'), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase() });
  if (parsed.data.length > 5000) throw badRequest('Maximum 5000 rows per import');
  const inst = req.ctx!.institutionId;
  const yearId = await currentYearId(inst);

  const secRows = yearId ? await db.select({ id: sections.id, name: sections.name, level: classLevels.name }).from(sections).innerJoin(classLevels, eq(classLevels.id, sections.classLevelId)).where(and(eq(sections.institutionId, inst), eq(sections.academicYearId, yearId))) : [];
  const secKey = (l: string, s: string) => `${l.trim().toLowerCase()}|${s.trim().toLowerCase()}`;
  const secMap = new Map(secRows.map((s) => [secKey(s.level, s.name), s.id]));
  const nums = parsed.data.map((r) => (r.admission_number ?? '').trim()).filter(Boolean);
  const existing = new Set(nums.length ? (await db.select({ a: students.admissionNumber }).from(students).where(and(eq(students.institutionId, inst), inArray(students.admissionNumber, nums)))).map((x) => x.a) : []);

  const seen = new Map<string, number>();
  const valid: { row: number; data: z.infer<typeof importRow>; sectionId: string | null }[] = [];
  const invalid: { row: number; errors: string[]; raw: Record<string, string> }[] = [];
  const duplicates: { row: number; admissionNumber: string; reason: string }[] = [];
  parsed.data.forEach((raw, i) => {
    const rowNo = i + 2;
    const r = importRow.safeParse(raw);
    if (!r.success) { invalid.push({ row: rowNo, errors: r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`), raw }); return; }
    const d = r.data;
    if (existing.has(d.admission_number)) { duplicates.push({ row: rowNo, admissionNumber: d.admission_number, reason: 'Already exists in this institution' }); return; }
    if (seen.has(d.admission_number)) { duplicates.push({ row: rowNo, admissionNumber: d.admission_number, reason: `Duplicate of row ${seen.get(d.admission_number)} in this file` }); return; }
    seen.set(d.admission_number, rowNo);
    let sectionId: string | null = null;
    if (d.class_level || d.section) {
      sectionId = secMap.get(secKey(d.class_level ?? '', d.section ?? '')) ?? null;
      if (!sectionId) { invalid.push({ row: rowNo, errors: [`Unknown class/section "${d.class_level} ${d.section}" in the current academic year`], raw }); return; }
    }
    valid.push({ row: rowNo, data: d, sectionId });
  });
  if (parsed.errors.length) parsed.errors.forEach((e) => invalid.push({ row: (e.row ?? 0) + 2, errors: [e.message], raw: {} }));

  const summary = { totalRows: parsed.data.length, valid: valid.length, invalid: invalid.length, duplicates: duplicates.length };
  if (mode === 'preview') return res.json({ data: { mode, summary, valid: valid.slice(0, 200).map((v) => ({ row: v.row, admissionNumber: v.data.admission_number, name: `${v.data.first_name} ${v.data.last_name ?? ''}`.trim(), hasSection: !!v.sectionId })), invalid, duplicates } });
  if (!valid.length) throw badRequest('No valid rows to import');

  await db.transaction(async (tx) => {
    for (const v of valid) {
      const d = v.data;
      const [s] = await tx.insert(students).values({
        institutionId: inst, admissionNumber: d.admission_number, firstName: d.first_name, lastName: d.last_name ?? '',
        dateOfBirth: d.date_of_birth || null, gender: d.gender || null, admissionDate: d.admission_date || null, email: d.email || null, phone: d.phone || null,
      }).returning({ id: students.id });
      if (v.sectionId && yearId) await tx.insert(studentEnrolments).values({ institutionId: inst, studentId: s.id, academicYearId: yearId, sectionId: v.sectionId, rollNumber: d.roll_number || null });
      if (d.guardian_name) {
        const [g] = await tx.insert(guardians).values({ institutionId: inst, fullName: d.guardian_name, phone: d.guardian_phone || null, email: d.guardian_email || null }).returning({ id: guardians.id });
        await tx.insert(studentGuardians).values({ institutionId: inst, studentId: s.id, guardianId: g.id, relationship: d.guardian_relationship || 'guardian', isPrimary: true });
      }
    }
    await auditReq(tx, req, { action: 'student.bulk_imported', entityType: 'student', metadata: summary });
  });
  res.status(201).json({ data: { mode, summary, imported: valid.length, invalid, duplicates } });
});

studentsRouter.get('/duplicates', requirePermission('students.manage'), async (req, res) => {
  const { rows } = await pool.query(
    `select lower(first_name) as first_name, lower(last_name) as last_name, date_of_birth, count(*)::int as n, array_agg(id) as ids, array_agg(admission_number) as admission_numbers
     from students where institution_id = $1 and deleted_at is null
     group by 1,2,3 having count(*) > 1 order by n desc limit 200`, [req.ctx!.institutionId]);
  res.json({ data: rows });
});

studentsRouter.get('/:id', requirePermission('students.read'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const inst = req.ctx!.institutionId;
  const [s] = await db.select().from(students).where(and(eq(students.id, id), eq(students.institutionId, inst), isNull(students.deletedAt)));
  if (!s) throw notFound('Student');
  const scope = await attendanceScope(req.ctx!);
  const enrol = await db.select({ id: studentEnrolments.id, academicYearId: studentEnrolments.academicYearId, yearName: academicYears.name, sectionId: sections.id, sectionName: sections.name, classLevelName: classLevels.name, rollNumber: studentEnrolments.rollNumber, isActive: studentEnrolments.isActive })
    .from(studentEnrolments).innerJoin(sections, eq(sections.id, studentEnrolments.sectionId)).innerJoin(classLevels, eq(classLevels.id, sections.classLevelId)).innerJoin(academicYears, eq(academicYears.id, studentEnrolments.academicYearId))
    .where(eq(studentEnrolments.studentId, id)).orderBy(asc(academicYears.startDate));
  if (!scope.all && !can(req, 'students.manage') && !enrol.some((e) => e.isActive && scope.rosterSectionIds.includes(e.sectionId))) throw notFound('Student');
  const gs = can(req, 'students.contact.read', 'students.manage')
    ? await db.select({ id: guardians.id, fullName: guardians.fullName, phone: guardians.phone, email: guardians.email, relationship: studentGuardians.relationship, isPrimary: studentGuardians.isPrimary, hasLogin: sql<boolean>`${guardians.userId} is not null` })
      .from(studentGuardians).innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId)).where(eq(studentGuardians.studentId, id))
    : [];
  const history = await db.select().from(studentStatusHistory).where(eq(studentStatusHistory.studentId, id)).orderBy(asc(studentStatusHistory.createdAt));
  res.json({ data: { ...present(req, s), hasLogin: !!s.userId, enrolments: enrol, guardians: gs, statusHistory: history } });
});

studentsRouter.post('/', requirePermission('students.manage'), async (req, res) => {
  const body = parse(createSchema, req.body);
  const inst = req.ctx!.institutionId;
  const out = await db.transaction(async (tx) => {
    let userId: string | null = null;
    if (body.login) {
      const [studentRole] = await tx.select().from(roles).where(and(eq(roles.institutionId, inst), eq(roles.key, 'student')));
      userId = (await createOrAttachUser(tx, inst, { email: body.login.email, fullName: `${body.firstName} ${body.lastName}`.trim(), password: body.login.password }, [studentRole.id])).user.id;
    }
    const { enrolment, login: _l, ...fields } = body;
    const [s] = await tx.insert(students).values({ ...fields, institutionId: inst, userId }).returning();
    if (enrolment) {
      await assertOwned(tx, inst, [[sections, enrolment.sectionId]]);
      const [sec] = await tx.select().from(sections).where(eq(sections.id, enrolment.sectionId));
      await tx.insert(studentEnrolments).values({ institutionId: inst, studentId: s.id, academicYearId: sec.academicYearId, sectionId: sec.id, rollNumber: enrolment.rollNumber ?? null, startDate: body.admissionDate ?? null });
    }
    await tx.insert(studentStatusHistory).values({ institutionId: inst, studentId: s.id, toStatus: 'active', reason: 'Admitted', changedByUserId: req.auth!.userId });
    await auditReq(tx, req, { action: 'student.created', entityType: 'student', entityId: s.id, after: s });
    return s;
  });
  res.status(201).json({ data: present(req, out) });
});

studentsRouter.patch('/:id', requirePermission('students.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(updateSchema, req.body);
  const inst = req.ctx!.institutionId;
  const [before] = await db.select().from(students).where(and(eq(students.id, id), eq(students.institutionId, inst), isNull(students.deletedAt)));
  if (!before) throw notFound('Student');
  const [after] = await db.update(students).set({ ...body, updatedAt: new Date() }).where(eq(students.id, id)).returning();
  await auditReq(db, req, { action: 'student.updated', entityType: 'student', entityId: id, before, after });
  res.json({ data: present(req, after) });
});

studentsRouter.post('/:id/status', requirePermission('students.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(z.object({ status: z.enum(['active', 'inactive', 'withdrawn', 'transferred', 'alumni', 'suspended']), reason: z.string().trim().min(3).max(500) }), req.body);
  const inst = req.ctx!.institutionId;
  const [s] = await db.select().from(students).where(and(eq(students.id, id), eq(students.institutionId, inst)));
  if (!s) throw notFound('Student');
  await db.transaction(async (tx) => {
    await tx.update(students).set({ status: body.status, updatedAt: new Date() }).where(eq(students.id, id));
    await tx.insert(studentStatusHistory).values({ institutionId: inst, studentId: id, fromStatus: s.status, toStatus: body.status, reason: body.reason, changedByUserId: req.auth!.userId });
    if (body.status !== 'active' && body.status !== 'suspended') await tx.update(studentEnrolments).set({ isActive: false, endDate: new Date().toISOString().slice(0, 10) }).where(and(eq(studentEnrolments.studentId, id), eq(studentEnrolments.isActive, true)));
    await auditReq(tx, req, { action: 'student.status_changed', entityType: 'student', entityId: id, before: { status: s.status }, after: body });
  });
  res.json({ data: { ok: true } });
});

/** Section change / transfer within the same academic year. Ends the old enrolment, preserving history. */
studentsRouter.post('/:id/enrolment', requirePermission('students.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(z.object({ sectionId: z.string().uuid(), rollNumber: z.string().max(20).optional(), effectiveDate: isoDate.optional() }), req.body);
  const inst = req.ctx!.institutionId;
  await assertOwned(db, inst, [[students, id], [sections, body.sectionId]]);
  const [sec] = await db.select().from(sections).where(eq(sections.id, body.sectionId));
  const eff = body.effectiveDate ?? new Date().toISOString().slice(0, 10);
  await db.transaction(async (tx) => {
    const old = await tx.update(studentEnrolments).set({ isActive: false, endDate: eff, updatedAt: new Date() })
      .where(and(eq(studentEnrolments.studentId, id), eq(studentEnrolments.academicYearId, sec.academicYearId), eq(studentEnrolments.isActive, true))).returning();
    await tx.insert(studentEnrolments).values({ institutionId: inst, studentId: id, academicYearId: sec.academicYearId, sectionId: sec.id, rollNumber: body.rollNumber ?? old[0]?.rollNumber ?? null, startDate: eff });
    await auditReq(tx, req, { action: 'student.section_changed', entityType: 'student', entityId: id, before: old[0] ?? null, after: body });
  });
  res.json({ data: { ok: true } });
});

/** Promote all active students of a section into a target section (usually next year's). */
studentsRouter.post('/promote', requirePermission('students.manage'), async (req, res) => {
  const body = parse(z.object({ fromSectionId: z.string().uuid(), toSectionId: z.string().uuid(), excludeStudentIds: z.array(z.string().uuid()).default([]) }), req.body);
  const inst = req.ctx!.institutionId;
  await assertOwned(db, inst, [[sections, body.fromSectionId], [sections, body.toSectionId]]);
  const [to] = await db.select().from(sections).where(eq(sections.id, body.toSectionId));
  const [from] = await db.select().from(sections).where(eq(sections.id, body.fromSectionId));
  if (to.academicYearId === from.academicYearId) throw badRequest('Target section must be in a different academic year; use section change instead');
  const promoted = await db.transaction(async (tx) => {
    const list = await tx.select().from(studentEnrolments).innerJoin(students, eq(students.id, studentEnrolments.studentId))
      .where(and(eq(studentEnrolments.sectionId, from.id), eq(studentEnrolments.isActive, true), eq(students.status, 'active')));
    const ids = list.map((l) => l.student_enrolments).filter((e) => !body.excludeStudentIds.includes(e.studentId));
    for (const e of ids) {
      await tx.update(studentEnrolments).set({ isActive: false, updatedAt: new Date() }).where(eq(studentEnrolments.id, e.id));
      await tx.insert(studentEnrolments).values({ institutionId: inst, studentId: e.studentId, academicYearId: to.academicYearId, sectionId: to.id, rollNumber: e.rollNumber }).onConflictDoNothing();
    }
    await auditReq(tx, req, { action: 'student.promoted', entityType: 'section', entityId: from.id, metadata: { to: to.id, count: ids.length } });
    return ids.length;
  });
  res.json({ data: { promoted } });
});

studentsRouter.delete('/:id', requirePermission('students.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const [s] = await db.select().from(students).where(and(eq(students.id, id), eq(students.institutionId, req.ctx!.institutionId), isNull(students.deletedAt)));
  if (!s) throw notFound('Student');
  await db.update(students).set({ deletedAt: new Date() }).where(eq(students.id, id));
  await auditReq(db, req, { action: 'student.deleted', entityType: 'student', entityId: id, before: s });
  res.json({ data: { ok: true } });
});

/** Create a portal login for an existing student. */
studentsRouter.post('/:id/login', requirePermission('students.manage', 'users.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(128) }), req.body);
  const inst = req.ctx!.institutionId;
  const [s] = await db.select().from(students).where(and(eq(students.id, id), eq(students.institutionId, inst)));
  if (!s) throw notFound('Student');
  if (s.userId) throw new AppError(409, 'HAS_LOGIN', 'This student already has a login');
  await db.transaction(async (tx) => {
    const [role] = await tx.select().from(roles).where(and(eq(roles.institutionId, inst), eq(roles.key, 'student')));
    const r = await createOrAttachUser(tx, inst, { email: body.email, fullName: `${s.firstName} ${s.lastName}`.trim(), password: body.password }, [role.id]);
    await tx.update(students).set({ userId: r.user.id }).where(eq(students.id, id));
    await auditReq(tx, req, { action: 'student.login_created', entityType: 'student', entityId: id });
  });
  res.status(201).json({ data: { ok: true } });
});

/**
 * ID card data + identity QR. The QR encodes only an opaque token (no personal data); scanning devices
 * resolve it server-side. Distinct from short-lived attendance-session QR codes.
 */
studentsRouter.get('/:id/id-card', requirePermission('students.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const inst = req.ctx!.institutionId;
  const [s] = await db.select().from(students).where(and(eq(students.id, id), eq(students.institutionId, inst)));
  if (!s) throw notFound('Student');
  const [i] = await db.select({ name: institutions.name, logoUrl: institutions.logoUrl, primaryColor: institutions.primaryColor }).from(institutions).where(eq(institutions.id, inst));
  const yearId = await currentYearId(inst);
  const [e] = yearId ? await db.select({ section: sections.name, level: classLevels.name, year: academicYears.name }).from(studentEnrolments)
    .innerJoin(sections, eq(sections.id, studentEnrolments.sectionId)).innerJoin(classLevels, eq(classLevels.id, sections.classLevelId)).innerJoin(academicYears, eq(academicYears.id, studentEnrolments.academicYearId))
    .where(and(eq(studentEnrolments.studentId, id), eq(studentEnrolments.isActive, true), eq(studentEnrolments.academicYearId, yearId))) : [];
  const qr = await QRCode.toDataURL(`AIQ-ID:${s.identityToken}`, { margin: 1, width: 240 });
  res.json({ data: { institution: i, student: { id: s.id, name: `${s.firstName} ${s.lastName}`.trim(), admissionNumber: s.admissionNumber, photoUrl: s.photoUrl }, enrolment: e ?? null, qrDataUrl: qr } });
});

/** Reissue identity token (lost card): old QR stops resolving immediately. */
studentsRouter.post('/:id/id-card/reissue', requirePermission('students.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const [s] = await db.update(students).set({ identityToken: sql`replace(gen_random_uuid()::text, '-', '')`, updatedAt: new Date() })
    .where(and(eq(students.id, id), eq(students.institutionId, req.ctx!.institutionId))).returning({ id: students.id });
  if (!s) throw notFound('Student');
  await auditReq(db, req, { action: 'student.id_card_reissued', entityType: 'student', entityId: id });
  res.json({ data: { ok: true } });
});
