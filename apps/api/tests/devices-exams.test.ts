import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app, api, registerInstitution, buildSchool, today, type Tenant } from './helpers.js';

describe('devices, cards and campus presence', () => {
  let A: Tenant; let B: Tenant; let s: Awaited<ReturnType<typeof buildSchool>>; let key: string;
  beforeAll(async () => { A = await registerInstitution(); B = await registerInstitution(); s = await buildSchool(A); });

  it('registers a device and shows the key once', async () => {
    const r = await api(A).post('/devices', { name: 'Main gate', kind: 'rfid_reader', location: 'Gate 1' });
    expect(r.status).toBe(201);
    key = r.body.data.deviceKey;
    expect(key).toMatch(/^aiqd_/);
    const list = await api(A).get('/devices');
    expect(JSON.stringify(list.body)).not.toContain(key);
  });
  it('ingests events idempotently and resolves cards within the tenant only', async () => {
    expect((await api(A).post('/devices/cards', { studentId: s.students[0].id, cardUid: 'CARD-0001' })).status).toBe(201);
    expect((await api(A).post('/devices/cards', { studentId: s.students[1].id, cardUid: 'CARD-0001' })).status).toBe(409);
    await api(B).post('/devices/cards', { studentId: s.students[0].id, cardUid: 'CARD-X' }).expect(400);
    const payload = { events: [{ eventId: 'e1', cardUid: 'CARD-0001', direction: 'in', occurredAt: new Date().toISOString() }, { eventId: 'e2', cardUid: 'UNKNOWN-99', direction: 'in', occurredAt: new Date().toISOString() }] };
    const r1 = await request(app).post('/api/device/events').set('X-Device-Key', key).send(payload);
    expect(r1.body.data).toMatchObject({ received: 2, stored: 2, unresolved: 1 });
    const r2 = await request(app).post('/api/device/events').set('X-Device-Key', key).send(payload);
    expect(r2.body.data).toMatchObject({ stored: 0, duplicates: 2 });
    expect((await request(app).post('/api/device/events').set('X-Device-Key', 'aiqd_wrong').send(payload)).status).toBe(401);
    const sum = await api(A).get('/devices/campus/summary');
    expect(sum.body.data.checkedIn).toBe(1);
    // Campus presence never creates class attendance
    const recs = await api(A).get(`/attendance/students/${s.students[0].id}/records`);
    expect(recs.body.data).toHaveLength(0);
  });
  it('lost card stops resolving', async () => {
    const cards = (await api(A).get('/devices/cards')).body.data;
    await api(A).post(`/devices/cards/${cards[0].id}/status`, { status: 'lost' }).expect(200);
    const r = await request(app).post('/api/device/events').set('X-Device-Key', key).send({ events: [{ eventId: 'e3', cardUid: 'CARD-0001', direction: 'out', occurredAt: new Date().toISOString() }] });
    expect(r.body.data.unresolved).toBe(1);
  });
});

describe('examination eligibility', () => {
  it('computes indicators, records exemptions, and keeps official decisions separate', async () => {
    const A = await registerInstitution();
    const s = await buildSchool(A);
    const t = api({ token: s.teacherToken, institutionId: A.institutionId });
    const sess = (await t.post('/attendance/sessions', { kind: 'daily', date: today(), sectionId: s.section.id })).body.data;
    await t.post(`/attendance/sessions/${sess.id}/submit`, { records: s.students.map((x, i) => ({ studentId: x.id, status: i === 0 ? 'absent' : 'present' })) });
    const exam = (await api(A).post('/exams', { name: 'Term exam', academicYearId: s.year.id, attendanceFrom: `${today().slice(0, 4)}-01-01`, attendanceTo: today() })).body.data;
    const c = await api(A).post(`/exams/${exam.id}/compute`);
    expect(c.body.data).toMatchObject({ students: 3, belowThreshold: 1 });
    const below = (await api(A).get(`/exams/${exam.id}/eligibility?filter=below`)).body.data;
    expect(below).toHaveLength(1);
    expect(below[0].status).toBe('computed');
    expect((await api(A).post(`/exams/${exam.id}/eligibility/${below[0].studentId}/exempt`, { reason: 'Hospitalised, certificate verified' })).status).toBe(200);
    expect((await t.post(`/exams/${exam.id}/eligibility/confirm`, { studentIds: [below[0].studentId], decision: 'confirmed_eligible' })).status).toBe(403);
    expect((await api(A).post(`/exams/${exam.id}/eligibility/confirm`, { studentIds: [below[0].studentId], decision: 'confirmed_eligible' })).body.data.updated).toBe(1);
    // recompute does not overwrite the decision
    await api(A).post(`/exams/${exam.id}/compute`);
    const all = (await api(A).get(`/exams/${exam.id}/eligibility?filter=all`)).body.data;
    expect(all.find((x: { studentId: string }) => x.studentId === below[0].studentId).status).toBe('confirmed_eligible');
  });
});
