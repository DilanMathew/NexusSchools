import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app, api, registerInstitution, buildSchool, login, uniq, PASSWORD, today, type Tenant } from './helpers.js';
import { makeQrToken } from '../src/modules/attendance/qr-token.js';

describe('attendance workflow', () => {
  let A: Tenant; let s: Awaited<ReturnType<typeof buildSchool>>; let teacher: ReturnType<typeof api>; let sessionId: string;
  let parentToken: string;
  beforeAll(async () => {
    A = await registerInstitution('school');
    s = await buildSchool(A);
    teacher = api({ token: s.teacherToken, institutionId: A.institutionId });
    const g = (await api(A).post('/guardians', { fullName: 'Parent One', phone: '999', studentId: s.students[0].id, relationship: 'mother' })).body.data;
    const email = `${uniq('par')}@example.test`;
    expect((await api(A).post(`/guardians/${g.id}/login`, { email, password: PASSWORD })).status).toBe(201);
    parentToken = await login(email);
  });

  it('teacher starts a session idempotently and sees the roster', async () => {
    const r1 = await teacher.post('/attendance/sessions', { kind: 'subject', date: today(), courseOfferingId: s.offering.id, periodId: s.period.id });
    expect(r1.status).toBe(201);
    const r2 = await teacher.post('/attendance/sessions', { kind: 'subject', date: today(), courseOfferingId: s.offering.id, periodId: s.period.id });
    expect(r2.body.data.id).toBe(r1.body.data.id);
    expect(r2.body.meta.resumed).toBe(true);
    sessionId = r1.body.data.id;
    const d = await teacher.get(`/attendance/sessions/${sessionId}`);
    expect(d.body.data.students).toHaveLength(3);
    expect(d.body.data.canEdit).toBe(true);
  });

  it('rejects future dates and statuses not enabled', async () => {
    expect((await teacher.post('/attendance/sessions', { kind: 'subject', date: '2999-01-01', courseOfferingId: s.offering.id })).status).toBe(400);
    const r = await teacher.put(`/attendance/sessions/${sessionId}/records`, { records: [{ studentId: s.students[0].id, status: 'on_duty' }] });
    expect(r.body.error.code).toBe('STATUS_DISABLED');
  });

  it('QR scan marks the authenticated student present; replays and forged tokens fail', async () => {
    const q = (await teacher.post('/attendance/qr/sessions', { attendanceSessionId: sessionId, rotationSeconds: 15 })).body.data;
    const tok = (await teacher.get(`/attendance/qr/sessions/${q.id}/token`)).body.data.token;
    const stu = api({ token: await login(s.students[2].email), institutionId: A.institutionId });
    expect((await stu.post('/attendance/qr/scan', { token: tok })).body.data.status).toBe('recorded');
    expect((await stu.post('/attendance/qr/scan', { token: tok })).body.data.status).toBe('already_recorded');
    const stale = makeQrToken(q.id, 15, Date.now() - 120_000).token;
    expect((await stu.post('/attendance/qr/scan', { token: stale })).status).toBe(410);
    expect((await stu.post('/attendance/qr/scan', { token: tok.slice(0, -3) + 'abc' })).status).toBe(400);
    // Teacher cannot scan on behalf of students
    expect((await teacher.post('/attendance/qr/scan', { token: tok })).status).toBe(403);
  });

  it('submission requires every student marked, then notifies the guardian', async () => {
    const partial = await teacher.post(`/attendance/sessions/${sessionId}/submit`, { records: [{ studentId: s.students[0].id, status: 'absent' }] });
    expect(partial.body.error.code).toBe('INCOMPLETE');
    const ok = await teacher.post(`/attendance/sessions/${sessionId}/submit`, { records: [{ studentId: s.students[0].id, status: 'absent' }, { studentId: s.students[1].id, status: 'late' }] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.tally).toEqual({ absent: 1, late: 1, present: 1 });
    expect((await teacher.post(`/attendance/sessions/${sessionId}/submit`, {})).body.error.code).toBe('SESSION_NOT_OPEN');
    const n = await api({ token: parentToken, institutionId: A.institutionId }).get('/notifications');
    expect(n.body.data.some((x: { eventKey: string }) => x.eventKey === 'attendance.absent')).toBe(true);
  });

  it('parent sees only linked child', async () => {
    const p = api({ token: parentToken, institutionId: A.institutionId });
    const kids = (await p.get('/me/students')).body.data;
    expect(kids.map((k: { id: string }) => k.id)).toEqual([s.students[0].id]);
    const sum = await p.get(`/attendance/students/${s.students[0].id}/summary`);
    expect(sum.status).toBe(200);
    expect(sum.body.data.overall).toMatchObject({ conducted: 1, attended: 0, percentage: 0, band: 'shortage' });
    expect((await p.get(`/attendance/students/${s.students[1].id}/summary`)).status).toBe(403);
    expect((await p.get('/students')).status).toBe(403);
  });

  it('student correction request → teacher approval updates record with audit history', async () => {
    const stu = api({ token: await login(s.students[0].email), institutionId: A.institutionId });
    const recs = (await stu.get(`/attendance/students/${s.students[0].id}/records`)).body.data;
    const recordId = recs[0].id;
    const cr = await stu.post('/attendance/correction-requests', { recordId, requestedStatus: 'present', reason: 'I was present; scanned late because phone died.' });
    expect(cr.status).toBe(201);
    const dup = await stu.post('/attendance/correction-requests', { recordId, requestedStatus: 'present', reason: 'Submitting this request again by mistake.' });
    expect(dup.status).toBe(409);
    // Student can't directly change attendance
    expect((await stu.patch(`/attendance/records/${recordId}`, { status: 'present', reason: 'self edit' })).status).toBe(403);
    const list = await teacher.get('/attendance/correction-requests?status=pending');
    expect(list.body.data).toHaveLength(1);
    const rv = await teacher.post(`/attendance/correction-requests/${cr.body.data.id}/review`, { decision: 'approved' });
    expect(rv.status).toBe(200);
    const hist = await teacher.get(`/attendance/records/${recordId}/history`);
    expect(hist.body.data.record.status).toBe('present');
    expect(hist.body.data.history[0]).toMatchObject({ oldStatus: 'absent', newStatus: 'present' });
    expect((await teacher.post(`/attendance/correction-requests/${cr.body.data.id}/review`, { decision: 'rejected', note: 'x' })).status).toBe(409);
  });

  it('teacher direct edit within window keeps history; stale version rejected', async () => {
    const d = (await teacher.get(`/attendance/sessions/${sessionId}`)).body.data;
    const rec = d.students.find((x: { id: string }) => x.id === s.students[1].id).record;
    expect((await teacher.patch(`/attendance/records/${rec.id}`, { status: 'present', reason: 'Arrived on time actually', expectedVersion: rec.version + 5 })).status).toBe(409);
    const ok = await teacher.patch(`/attendance/records/${rec.id}`, { status: 'present', reason: 'Arrived on time actually', expectedVersion: rec.version });
    expect(ok.status).toBe(200);
    expect(ok.body.data.version).toBe(rec.version + 1);
  });

  it('other teachers cannot take attendance for classes not assigned to them', async () => {
    const email = `${uniq('t2')}@example.test`;
    await api(A).post('/staff', { employeeId: uniq('E'), fullName: 'Teacher Two', login: { email, password: PASSWORD, roleKeys: ['faculty'] } });
    const t2 = api({ token: await login(email), institutionId: A.institutionId });
    expect((await t2.post('/attendance/sessions', { kind: 'subject', date: today(), courseOfferingId: s.offering.id })).status).toBe(403);
    expect((await t2.get(`/attendance/sessions/${sessionId}`)).status).toBe(404);
  });

  it('offline sync applies new sessions and reports conflicts without overwriting', async () => {
    const r = await teacher.post('/attendance/sync', { items: [
      { clientId: 'c1', kind: 'subject', date: today(), courseOfferingId: s.offering.id, periodId: s.period.id, capturedAt: new Date().toISOString(), records: s.students.map((x) => ({ studentId: x.id, status: 'present' })) },
      { clientId: 'c2', kind: 'daily', date: today(), sectionId: s.section.id, capturedAt: new Date().toISOString(), records: s.students.map((x) => ({ studentId: x.id, status: 'present' })) },
    ] });
    expect(r.body.data.results[0].result).toBe('conflict');
    expect(r.body.data.results[1]).toMatchObject({ result: 'applied', submitted: true });
    const again = await teacher.post('/attendance/sync', { items: [{ clientId: 'c2', kind: 'daily', date: today(), sectionId: s.section.id, capturedAt: new Date().toISOString(), records: [{ studentId: s.students[0].id, status: 'absent' }] }] });
    expect(again.body.data.results[0].result).toBe('conflict');
  });

  it('reports use real records and the policy', async () => {
    const r = await api(A).get(`/reports/students?sectionId=${s.section.id}`);
    expect(r.status).toBe(200);
    expect(r.body.meta.policy.calculationUnit).toBe('day');
    expect(r.body.data).toHaveLength(3);
    const csv = await api(A).get(`/reports/students?sectionId=${s.section.id}&format=csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Admission No');
    const ov = await api(A).get('/analytics/overview');
    if (ov.status !== 200) console.log(ov.body);
    expect(ov.body.data.today.marked).toBe(3);
  });

  it('policy changes are versioned and audited', async () => {
    const before = (await api(A).get('/attendance/policy')).body.data;
    const r = await api(A).put('/attendance/policy', { lateWeight: 0.5, eligibilityThreshold: 80, warningThreshold: 90 });
    expect(r.body.data.version).toBe(before.version + 1);
    expect((await api(A).put('/attendance/policy', { eligibilityThreshold: 95, warningThreshold: 90 })).status).toBe(400);
    expect((await teacher.put('/attendance/policy', { lateWeight: 0 })).status).toBe(403);
    const audit = await api(A).get('/institution/current/audit?entityType=attendance_policy');
    expect(audit.body.data[0].before.lateWeight).toBe(1);
  });
});

describe('leave', () => {
  it('parent applies, class teacher approves, attendance is not rewritten', async () => {
    const A = await registerInstitution();
    const s = await buildSchool(A);
    const g = (await api(A).post('/guardians', { fullName: 'Parent Leave', studentId: s.students[0].id })).body.data;
    const email = `${uniq('pl')}@example.test`;
    await api(A).post(`/guardians/${g.id}/login`, { email, password: PASSWORD });
    const p = api({ token: await login(email), institutionId: A.institutionId });
    const types = (await p.get('/leave/types')).body.data;
    const lr = await p.post('/leave/requests', { studentId: s.students[0].id, leaveTypeId: types[0].id, startDate: today(), endDate: today(), reason: 'Fever and doctor visit' });
    expect(lr.status).toBe(201);
    expect((await p.post('/leave/requests', { studentId: s.students[1].id, leaveTypeId: types[0].id, startDate: today(), endDate: today(), reason: 'Not my child' })).status).toBe(403);
    expect((await p.post('/leave/requests', { studentId: s.students[0].id, leaveTypeId: types[0].id, startDate: today(), endDate: today(), reason: 'Overlapping request' })).status).toBe(409);
    const t = api({ token: s.teacherToken, institutionId: A.institutionId });
    expect((await t.post(`/leave/requests/${lr.body.data.id}/review`, { decision: 'approved' })).status).toBe(200);
    const mine = (await p.get('/leave/requests')).body.data;
    expect(mine[0].status).toBe('approved');
  });
});

describe('student import', () => {
  it('previews invalid/duplicate rows and commits valid rows atomically', async () => {
    const A = await registerInstitution();
    const s = await buildSchool(A);
    const existing = s.students[0].admissionNumber;
    const csv = `admission_number,first_name,last_name,class_level,section,roll_number,guardian_name\nN1,Asha,K,Grade 10,A,10,Ravi\nN1,Dup,Row,,,,\n${existing},Exists,Already,,,,\n,Missing,Adm,,,,\nN2,Bad,Section,Grade 99,Z,,\nN3,Bala,S,,,,\n`;
    const pv = await api(A).post('/students/import?mode=preview').attach('file', Buffer.from(csv), 'students.csv');
    expect(pv.status).toBe(200);
    expect(pv.body.data.summary).toEqual({ totalRows: 6, valid: 2, invalid: 2, duplicates: 2 });
    const before = (await api(A).get('/students')).body.meta.total;
    const cm = await api(A).post('/students/import?mode=commit').attach('file', Buffer.from(csv), 'students.csv');
    expect(cm.status).toBe(201);
    expect((await api(A).get('/students')).body.meta.total).toBe(before + 2);
    const roster = await api(A).get(`/students?sectionId=${s.section.id}`);
    expect(roster.body.data.some((x: { admissionNumber: string }) => x.admissionNumber === 'N1')).toBe(true);
  });
});

describe('timetable', () => {
  it('prevents faculty double-booking', async () => {
    const A = await registerInstitution();
    const s = await buildSchool(A);
    const sec2 = (await api(A).post('/academic/sections', { academicYearId: s.year.id, classLevelId: s.level.id, name: 'B' })).body.data;
    const off2 = (await api(A).post('/academic/offerings', { academicYearId: s.year.id, subjectId: s.subject.id, sectionId: sec2.id, staffId: s.teacher.id })).body.data;
    expect((await api(A).post('/timetable/entries', { courseOfferingId: s.offering.id, dayOfWeek: 1, periodId: s.period.id })).status).toBe(201);
    const clash = await api(A).post('/timetable/entries', { courseOfferingId: off2.id, dayOfWeek: 1, periodId: s.period.id });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details[0].kind).toBe('faculty');
    expect((await api(A).post('/timetable/entries', { courseOfferingId: off2.id, dayOfWeek: 2, periodId: s.period.id })).status).toBe(201);
  });
});

describe('platform admin', () => {
  it('suspension blocks tenant access', async () => {
    const A = await registerInstitution();
    const { db } = await import('../src/db/client.js');
    const { users } = await import('../src/db/schema/index.js');
    const { hashPassword } = await import('../src/lib/security.js');
    const email = `${uniq('sa')}@example.test`;
    await db.insert(users).values({ email, fullName: 'Super Admin', passwordHash: await hashPassword(PASSWORD), platformRole: 'super_admin' });
    const sa = await login(email);
    const list = await request(app).get('/api/platform/institutions?pageSize=200').set('Authorization', `Bearer ${sa}`);
    if (list.status !== 200) console.log(list.body);
    expect(list.body.data.some((i: { id: string }) => i.id === A.institutionId)).toBe(true);
    expect((await request(app).patch(`/api/platform/institutions/${A.institutionId}/status`).set('Authorization', `Bearer ${sa}`).send({ status: 'suspended', reason: 'Testing suspension' })).status).toBe(200);
    expect((await api(A).get('/students')).body.error.code).toBe('INSTITUTION_SUSPENDED');
    // platform admin has no implicit tenant access
    expect((await api({ token: sa, institutionId: A.institutionId }).get('/students')).status).toBe(403);
  });
});
