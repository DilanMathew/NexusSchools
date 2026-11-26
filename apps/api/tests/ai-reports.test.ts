import { describe, it, expect, beforeAll } from 'vitest';
import { api, registerInstitution, buildSchool, today, type Tenant } from './helpers.js';
import ExcelJS from 'exceljs';

describe('assistant (built-in mode) and exports', () => {
  let A: Tenant; let B: Tenant; let s: Awaited<ReturnType<typeof buildSchool>>;
  beforeAll(async () => {
    A = await registerInstitution(); B = await registerInstitution();
    s = await buildSchool(A);
    const t = api({ token: s.teacherToken, institutionId: A.institutionId });
    const sess = (await t.post('/attendance/sessions', { kind: 'daily', date: today(), sectionId: s.section.id })).body.data;
    await t.post(`/attendance/sessions/${sess.id}/submit`, { records: s.students.map((x, i) => ({ studentId: x.id, status: i === 0 ? 'absent' : 'present' })) });
  });

  it('reports built-in mode when no AI provider is configured', async () => {
    const r = await api(A).get('/ai/status');
    expect(r.body.data.assistant).toMatchObject({ available: true, mode: 'builtin' });
  });
  it('answers from real data within the tenant', async () => {
    const r = await api(A).post('/ai/assistant', { question: "Show today's absent students" });
    expect(r.status).toBe(200);
    expect(r.body.data.toolCalls[0]).toMatchObject({ tool: 'absent_students_on_date', rows: 1 });
    expect(r.body.data.answer).toContain('Student1');
    const other = await api(B).post('/ai/assistant', { question: "Show today's absent students" });
    expect(other.body.data.toolCalls[0].rows).toBe(0);
    expect(other.body.data.answer).not.toContain('Student1');
    const below = await api(A).post('/ai/assistant', { question: 'Which students are below 75% attendance?' });
    expect(below.body.data.toolCalls[0].tool).toBe('students_below_threshold');
  });
  it('requires the ai.use permission', async () => {
    expect((await api({ token: s.teacherToken, institutionId: A.institutionId }).post('/ai/assistant', { question: 'absent today' })).status).toBe(403);
  });
  it('exports a real xlsx workbook', async () => {
    const r = await api(A).get(`/reports/students?sectionId=${s.section.id}&format=xlsx`).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(r.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as never);
    const values = wb.worksheets[0].getSheetValues().flat().map(String);
    expect(values).toContain('Admission No');
    expect(values.some((v) => v.includes('Student1'))).toBe(true);
  });
});
