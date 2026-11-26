import request from 'supertest';
import { createApp } from '../src/app.js';

export const app = createApp();
let n = 0;
export const uniq = (p = 'x') => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;
export const PASSWORD = 'Passw0rd-Test-123';

export interface Tenant { token: string; institutionId: string; email: string }

export async function registerInstitution(type: 'school' | 'college' = 'school', name = uniq('Inst ')): Promise<Tenant> {
  const email = `${uniq('owner')}@example.test`;
  const r = await request(app).post('/api/auth/register-institution').send({ institution: { name, type }, owner: { fullName: 'Owner Person', email, password: PASSWORD } });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.data.accessToken, institutionId: r.body.data.institutionId, email };
}

export async function login(email: string, password = PASSWORD) {
  const r = await request(app).post('/api/auth/login').send({ email, password });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.accessToken as string;
}

/** Tenant-scoped request helper. */
export function api(t: { token: string; institutionId: string }) {
  const h = (req: request.Test) => req.set('Authorization', `Bearer ${t.token}`).set('X-Institution-Id', t.institutionId);
  return {
    get: (p: string) => h(request(app).get(`/api/t${p}`)),
    post: (p: string, body?: object) => (body === undefined && p.includes('import') ? h(request(app).post(`/api/t${p}`)) : h(request(app).post(`/api/t${p}`)).send(body ?? {})),
    put: (p: string, body?: object) => h(request(app).put(`/api/t${p}`)).send(body ?? {}),
    patch: (p: string, body?: object) => h(request(app).patch(`/api/t${p}`)).send(body ?? {}),
    delete: (p: string) => h(request(app).delete(`/api/t${p}`)),
  };
}

export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** Builds a minimal academic setup: year, level, section, subject, offering, period, a teacher with login, 3 students. */
export async function buildSchool(t: Tenant) {
  const a = api(t);
  const td = today();
  const year = (await a.post('/academic/years', { name: uniq('AY'), startDate: `${td.slice(0, 4)}-01-01`, endDate: `${td.slice(0, 4)}-12-31`, isCurrent: true })).body.data;
  const level = (await a.post('/academic/class-levels', { name: 'Grade 10', ordinal: 10 })).body.data;
  const teacherEmail = `${uniq('teacher')}@example.test`;
  const teacher = (await a.post('/staff', { employeeId: uniq('E'), fullName: 'Teacher One', login: { email: teacherEmail, password: PASSWORD, roleKeys: ['class_teacher'] } })).body.data;
  const section = (await a.post('/academic/sections', { academicYearId: year.id, classLevelId: level.id, name: 'A', classTeacherStaffId: teacher.id })).body.data;
  const subject = (await a.post('/academic/subjects', { name: 'Mathematics', code: uniq('M').toUpperCase().slice(0, 10) })).body.data;
  const offering = (await a.post('/academic/offerings', { academicYearId: year.id, subjectId: subject.id, sectionId: section.id, staffId: teacher.id })).body.data;
  const period = (await a.post('/academic/periods', { name: 'P1', ordinal: 1, startTime: '00:00', endTime: '00:45' })).body.data;
  const studentsOut = [];
  for (let i = 1; i <= 3; i++) {
    const email = `${uniq('stu')}@example.test`;
    const s = (await a.post('/students', { admissionNumber: uniq('ADM'), firstName: `Student${i}`, lastName: 'Test', enrolment: { sectionId: section.id, rollNumber: String(i) }, login: { email, password: PASSWORD } })).body.data;
    studentsOut.push({ ...s, email });
  }
  const teacherToken = await login(teacherEmail);
  return { year, level, section, subject, offering, period, teacher, teacherEmail, teacherToken, students: studentsOut };
}
