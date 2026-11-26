import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app, api, registerInstitution, buildSchool, login, uniq, PASSWORD, type Tenant } from './helpers.js';

describe('auth', () => {
  it('registers an institution and logs in', async () => {
    const t = await registerInstitution('college');
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${t.token}`).set('X-Institution-Id', t.institutionId);
    expect(me.status).toBe(200);
    expect(me.body.data.context.roleKeys).toContain('owner');
    expect(me.body.data.context.permissions).toContain('students.manage');
    const inst = await api(t).get('/institution/current');
    expect(inst.body.data.type).toBe('college');
    expect(inst.body.data.settings.modules.subjectAttendance).toBe(true);
    expect(inst.body.data.subscription.status).toBe('trial');
  });
  it('rejects bad credentials generically and locks after repeated failures', async () => {
    const t = await registerInstitution();
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/api/auth/login').send({ email: t.email, password: 'wrong-password-1' });
      expect(r.status).toBe(401);
    }
    const locked = await request(app).post('/api/auth/login').send({ email: t.email, password: PASSWORD });
    expect(locked.status).toBe(423);
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.test', password: 'whatever1' });
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
  });
  it('rotates refresh tokens and detects reuse', async () => {
    const t = await registerInstitution();
    const l = await request(app).post('/api/auth/login').send({ email: t.email, password: PASSWORD });
    const cookie = l.headers['set-cookie'][0].split(';')[0];
    const r1 = await request(app).post('/api/auth/refresh').set('Cookie', cookie).set('X-Requested-With', 'attendiq');
    expect(r1.status).toBe(200);
    const reuse = await request(app).post('/api/auth/refresh').set('Cookie', cookie).set('X-Requested-With', 'attendiq');
    expect(reuse.status).toBe(401);
    const newCookie = r1.headers['set-cookie'][0].split(';')[0];
    const afterTheft = await request(app).post('/api/auth/refresh').set('Cookie', newCookie).set('X-Requested-With', 'attendiq');
    expect(afterTheft.status).toBe(401); // whole family revoked
  });
  it('rejects weak passwords', async () => {
    const r = await request(app).post('/api/auth/register-institution').send({ institution: { name: 'Weak School', type: 'school' }, owner: { fullName: 'X Y', email: `${uniq()}@example.test`, password: 'short' } });
    expect(r.status).toBe(400);
  });
});

describe('tenant isolation', () => {
  let A: Tenant; let B: Tenant; let a: Awaited<ReturnType<typeof buildSchool>>;
  beforeAll(async () => {
    A = await registerInstitution('school', 'ABC Isolation School');
    B = await registerInstitution('college', 'XYZ Isolation College');
    a = await buildSchool(A);
  });

  it('blocks access to an institution the user is not a member of', async () => {
    const r = await api({ token: B.token, institutionId: A.institutionId }).get('/students');
    expect(r.status).toBe(403);
  });
  it('lists only own students', async () => {
    const r = await api(B).get('/students');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(0);
  });
  it('cannot read, update or delete another tenant record by id', async () => {
    const sid = a.students[0].id;
    expect((await api(B).get(`/students/${sid}`)).status).toBe(404);
    expect((await api(B).patch(`/students/${sid}`, { firstName: 'Hacked' })).status).toBe(404);
    expect((await api(B).delete(`/students/${sid}`)).status).toBe(404);
    expect((await api(B).get(`/academic/sections/${a.section.id}`)).status).toBe(404);
    expect((await api(B).get(`/attendance/students/${sid}/summary`)).status).toBe(403);
    const still = await api(A).get(`/students/${sid}`);
    expect(still.body.data.firstName).toBe('Student1');
  });
  it('cannot reference another tenant record when creating data', async () => {
    const year = (await api(B).post('/academic/years', { name: 'Year B', startDate: '2026-01-01', endDate: '2026-12-31' })).body.data;
    const r = await api(B).post('/academic/sections', { academicYearId: year.id, classLevelId: a.level.id, name: 'Z' });
    expect(r.status).toBe(400);
    const s = await api(B).post('/attendance/sessions', { kind: 'subject', date: '2026-01-05', courseOfferingId: a.offering.id });
    expect(s.status).toBe(400);
  });
  it('ignores a forged institution id in the body', async () => {
    const r = await api(B).post('/academic/departments', { name: 'Forged', code: 'FRG', institutionId: A.institutionId });
    expect(r.status).toBe(201);
    expect(r.body.data.institutionId).toBe(B.institutionId);
  });
  it('audit log is tenant scoped', async () => {
    const r = await api(B).get('/institution/current/audit?pageSize=200');
    expect(r.body.data.every((x: { entityId: string }) => x.entityId !== a.students[0].id)).toBe(true);
  });
});

describe('rbac', () => {
  let A: Tenant; let s: Awaited<ReturnType<typeof buildSchool>>;
  beforeAll(async () => { A = await registerInstitution(); s = await buildSchool(A); });

  it('students cannot manage data or read other students', async () => {
    const tok = await login(s.students[0].email);
    const st = api({ token: tok, institutionId: A.institutionId });
    expect((await st.post('/students', { admissionNumber: 'X1', firstName: 'X' })).status).toBe(403);
    expect((await st.get('/students')).status).toBe(403);
    expect((await st.get(`/attendance/students/${s.students[0].id}/summary`)).status).toBe(200);
    expect((await st.get(`/attendance/students/${s.students[1].id}/summary`)).status).toBe(403);
    expect((await st.post('/attendance/sessions', { kind: 'subject', date: '2026-01-05', courseOfferingId: s.offering.id })).status).toBe(403);
  });
  it('teachers cannot escalate privileges', async () => {
    const t = api({ token: s.teacherToken, institutionId: A.institutionId });
    expect((await t.get('/users')).status).toBe(403);
    expect((await t.post('/roles', { name: 'Evil', permissions: ['students.manage'] })).status).toBe(403);
  });
  it('admins cannot grant permissions they lack (no escalation to owner)', async () => {
    const roles = (await api(A).get('/roles')).body.data as { id: string; key: string }[];
    const adminRole = roles.find((r) => r.key === 'admin')!;
    const ownerRole = roles.find((r) => r.key === 'owner')!;
    const email = `${uniq('adm')}@example.test`;
    expect((await api(A).post('/users', { email, fullName: 'Admin Two', password: PASSWORD, roleIds: [adminRole.id] })).status).toBe(201);
    const adm = api({ token: await login(email), institutionId: A.institutionId });
    expect((await adm.post('/users', { email: `${uniq()}@example.test`, fullName: 'Sneaky', password: PASSWORD, roleIds: [ownerRole.id] })).status).toBe(403);
    expect((await adm.post('/roles', { name: 'Billing', permissions: ['subscription.manage'] })).status).toBe(403);
    expect((await adm.post('/roles', { name: 'Readers', permissions: ['students.read'] })).status).toBe(201);
  });
  it('custom roles grant exactly their permissions', async () => {
    const role = (await api(A).post('/roles', { name: 'Report viewer', permissions: ['reports.read'] })).body.data;
    const email = `${uniq('rv')}@example.test`;
    await api(A).post('/users', { email, fullName: 'Report Viewer', password: PASSWORD, roleIds: [role.id] });
    const rv = api({ token: await login(email), institutionId: A.institutionId });
    expect((await rv.get('/reports/students')).status).toBe(200);
    expect((await rv.get('/students')).status).toBe(403);
  });
  it('platform endpoints require platform admin', async () => {
    const r = await request(app).get('/api/platform/institutions').set('Authorization', `Bearer ${A.token}`);
    expect(r.status).toBe(403);
  });
});
