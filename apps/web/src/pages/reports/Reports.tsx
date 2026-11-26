import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Printer } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { BAND_META, STATUS_META, type AttendanceStatus } from '../../lib/types';
import { Badge, Button, Card, Empty, Field, PageHeader, QueryState, Select, Tabs } from '../../components/ui';
import { useDepts, useSectionOptions } from '../../lib/lookups';
import { addDaysIso, fmtDate, fmtPct, todayIso } from '../../lib/format';

type Tab = 'students' | 'monthly' | 'daily' | 'absences' | 'compliance';

export default function Reports() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'students';
  return (
    <div>
      <PageHeader title="Reports" subtitle="Generated from submitted attendance records using your institution's current policy. Export to Excel or CSV, or print / save as PDF." />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t })} tabs={[{ key: 'students', label: 'Attendance & eligibility' }, { key: 'monthly', label: 'Monthly register' }, { key: 'daily', label: 'Daily register' }, { key: 'absences', label: 'Consecutive absences' }, { key: 'compliance', label: 'Submission compliance' }]} />
      {tab === 'students' && <StudentReport />}
      {tab === 'monthly' && <MonthlyRegister />}
      {tab === 'daily' && <DailyRegister />}
      {tab === 'absences' && <Absences />}
      {tab === 'compliance' && <Compliance />}
    </div>
  );
}

function Actions({ csv, name }: { csv: string; name: string }) {
  return <div className="no-print flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => api.download(csv.replace('format=csv', 'format=xlsx'), `${name}.xlsx`)}><Download className="h-4 w-4" />Excel</Button><Button size="sm" variant="outline" onClick={() => api.download(csv, `${name}.csv`)}><Download className="h-4 w-4" />CSV</Button><Button size="sm" variant="outline" onClick={() => window.print()} title="Use your browser's 'Save as PDF' to get a PDF"><Printer className="h-4 w-4" />Print / PDF</Button></div>;
}

function StudentReport() {
  const sections = useSectionOptions(); const depts = useDepts();
  const [f, setF] = useState({ from: '', to: '', sectionId: '', departmentId: '', band: '', sort: 'name' });
  const [courseOfferingId, setOffering] = useState('');
  const offerings = useQuery({ queryKey: ['offerings', 'section', f.sectionId], queryFn: () => api.get<{ id: string; subjectId: string }[]>(`/academic/offerings?sectionId=${f.sectionId}&pageSize=100`), enabled: !!f.sectionId });
  const subjects = useQuery({ queryKey: ['lookup', '/academic/subjects?pageSize=500'], queryFn: async () => (await api.get<{ id: string; name: string }[]>('/academic/subjects?pageSize=500')).data, enabled: !!f.sectionId });
  const params = { ...f, courseOfferingId };
  const q = useQuery({ queryKey: ['report', 'students', params], queryFn: () => api.get<{ studentId: string; name: string; admissionNumber: string; rollNumber: string; classLabel: string; attended: number; conducted: number; percentage: number | null; absent: number; late: number; leave: number; band: string; sessionsNeeded: number | null; maxMissable: number }[]>(`/reports/students${qs(params)}`) });
  const meta = q.data?.meta as { from: string; to: string; policy: { version: number; calculationUnit: string; eligibilityThreshold: number } } | undefined;
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Card title={meta ? `Attendance ${fmtDate(meta.from)} – ${fmtDate(meta.to)}` : 'Attendance report'} actions={<Actions csv={`/reports/students${qs({ ...params, format: 'csv' })}`} name="attendance-report" />} bodyClass="p-0">
      <div className="no-print grid gap-2 border-b border-slate-100 p-3 sm:grid-cols-3 lg:grid-cols-7">
        <input type="date" className="input" value={f.from} onChange={(e) => set('from')(e.target.value)} aria-label="From" />
        <input type="date" className="input" value={f.to} onChange={(e) => set('to')(e.target.value)} aria-label="To" />
        <Select value={f.departmentId} onChange={set('departmentId')} placeholder="All departments" options={(depts.data ?? []).map((d) => ({ value: d.id, label: d.name }))} />
        <Select value={f.sectionId} onChange={(v) => { set('sectionId')(v); setOffering(''); }} placeholder="All classes" options={sections.options} />
        <Select value={courseOfferingId} onChange={setOffering} disabled={!f.sectionId} placeholder="All subjects" options={(offerings.data?.data ?? []).map((o) => ({ value: o.id, label: subjects.data?.find((s) => s.id === o.subjectId)?.name ?? 'Subject' }))} />
        <Select value={f.band} onChange={set('band')} placeholder="All bands" options={[{ value: 'shortage', label: 'Shortage only' }, { value: 'warning', label: 'Warning only' }, { value: 'eligible', label: 'Eligible only' }]} />
        <Select value={f.sort} onChange={set('sort')} options={[{ value: 'name', label: 'Sort: class & roll' }, { value: 'percentage', label: 'Sort: lowest %' }, { value: 'absent', label: 'Sort: most absences' }, { value: 'late', label: 'Sort: most late' }]} />
      </div>
      <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No attendance in this range" /> : undefined}>
        <div className="overflow-x-auto"><table className="w-full min-w-[860px]">
          <thead className="bg-slate-50"><tr><th className="th">Student</th><th className="th">Class</th><th className="th text-right">Attended</th><th className="th text-right">Counted</th><th className="th text-right">%</th><th className="th text-right">Absent</th><th className="th text-right">Late</th><th className="th text-right">Leave</th><th className="th">Band</th><th className="th text-right">Needs / can miss</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{q.data?.data.map((r) => (
            <tr key={r.studentId}><td className="td"><Link className="font-medium hover:text-brand-700" to={`/students/${r.studentId}`}>{r.name}</Link><div className="text-xs text-slate-500">{r.admissionNumber}{r.rollNumber && ` · Roll ${r.rollNumber}`}</div></td><td className="td">{r.classLabel}</td>
              <td className="td text-right tabular-nums">{r.attended}</td><td className="td text-right tabular-nums">{r.conducted}</td><td className="td text-right font-medium tabular-nums">{fmtPct(r.percentage)}</td><td className="td text-right tabular-nums">{r.absent}</td><td className="td text-right tabular-nums">{r.late}</td><td className="td text-right tabular-nums">{r.leave}</td>
              <td className="td"><Badge className={BAND_META[r.band].cls}>{BAND_META[r.band].label}</Badge></td><td className="td text-right tabular-nums text-xs">{r.band === 'shortage' ? `needs ${r.sessionsNeeded ?? '—'}` : `can miss ${r.maxMissable}`}</td></tr>))}</tbody>
        </table></div>
        {meta && <p className="px-4 py-3 text-xs text-slate-500">{q.data?.data.length} students · policy v{meta.policy.version}, {meta.policy.calculationUnit}-based, eligibility {meta.policy.eligibilityThreshold}%. Indicative; official eligibility is decided by the institution.</p>}
      </QueryState>
    </Card>
  );
}

function MonthlyRegister() {
  const sections = useSectionOptions();
  const [sectionId, setSection] = useState('');
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const sid = sectionId || sections.options[0]?.value || '';
  const q = useQuery({ queryKey: ['report', 'monthly', sid, month], queryFn: () => api.get<{ section: string; days: string[]; rows: { studentId: string; name: string; rollNumber: string | null; marks: string[]; percentage: number | null }[] }>(`/reports/monthly-register${qs({ sectionId: sid, month })}`), enabled: !!sid });
  const d = q.data?.data;
  return (
    <Card title={d ? `${d.section} · ${new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}` : 'Monthly register'} actions={<Actions csv={`/reports/monthly-register${qs({ sectionId: sid, month, format: 'csv' })}`} name={`monthly-register-${month}`} />} bodyClass="p-0">
      <div className="no-print flex flex-wrap gap-2 border-b border-slate-100 p-3"><Select className="w-auto" value={sid} onChange={setSection} options={sections.options} /><input type="month" className="input w-auto" value={month} onChange={(e) => setMonth(e.target.value)} /></div>
      <QueryState q={q}>
        {d && (
          <div className="overflow-x-auto"><table className="w-full border-collapse text-xs">
            <thead className="bg-slate-50"><tr><th className="th sticky left-0 bg-slate-50">Student</th>{d.days.map((x) => <th key={x} className="px-1 py-2 text-center font-medium text-slate-500">{x.slice(8)}</th>)}<th className="th text-right">%</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{d.rows.map((r) => (
              <tr key={r.studentId}><td className="sticky left-0 whitespace-nowrap bg-white px-3 py-1.5"><span className="mr-2 text-slate-400">{r.rollNumber}</span>{r.name}</td>
                {r.marks.map((m, i) => <td key={i} className={`px-1 py-1.5 text-center font-medium ${m === 'A' ? 'text-red-600' : m === 'L' ? 'text-amber-600' : m.includes('A') ? 'text-orange-600' : 'text-slate-600'}`}>{m}</td>)}
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtPct(r.percentage)}</td></tr>))}</tbody>
          </table></div>
        )}
        <p className="px-4 py-2 text-xs text-slate-500">P present · A absent · L late · H half-day · LV leave · ML medical · OD on duty · P/A partially absent that day · blank = no session.</p>
      </QueryState>
    </Card>
  );
}

function DailyRegister() {
  const sections = useSectionOptions();
  const [sectionId, setSection] = useState('');
  const [date, setDate] = useState(todayIso());
  const sid = sectionId || sections.options[0]?.value || '';
  const q = useQuery({ queryKey: ['report', 'daily', sid, date], queryFn: () => api.get<{ sessions: { id: string; label: string; status: string }[]; rows: { name: string; rollNumber: string | null; marks: (AttendanceStatus | null)[] }[] }>(`/reports/daily-register${qs({ sectionId: sid, date })}`), enabled: !!sid });
  const d = q.data?.data;
  return (
    <Card title={`Daily register · ${sections.label(sid)} · ${fmtDate(date)}`} actions={<Actions csv={`/reports/daily-register${qs({ sectionId: sid, date, format: 'csv' })}`} name={`daily-register-${date}`} />} bodyClass="p-0">
      <div className="no-print flex flex-wrap gap-2 border-b border-slate-100 p-3"><Select className="w-auto" value={sid} onChange={setSection} options={sections.options} /><input type="date" className="input w-auto" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <QueryState q={q} empty={d && !d.sessions.length ? <Empty title="No attendance taken for this class on this day" /> : undefined}>
        {d && <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50"><tr><th className="th">Student</th>{d.sessions.map((s) => <th key={s.id} className="th">{s.label}{s.status === 'open' && ' (draft)'}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">{d.rows.map((r, i) => <tr key={i}><td className="td"><span className="mr-2 text-slate-400">{r.rollNumber}</span>{r.name}</td>{r.marks.map((m, j) => <td key={j} className="td">{m ? <Badge className={STATUS_META[m].cls}>{STATUS_META[m].short}</Badge> : '—'}</td>)}</tr>)}</tbody></table></div>}
      </QueryState>
    </Card>
  );
}

function Absences() {
  const [minDays, setMin] = useState('3');
  const q = useQuery({ queryKey: ['report', 'absences', minDays], queryFn: () => api.get<{ studentId: string; name: string; admissionNumber: string; classLabel: string; current: number; longest: number; lastAbsent: string }[]>(`/reports/consecutive-absences?minDays=${minDays}`) });
  return (
    <Card title="Students currently on a run of absences" actions={<Actions csv={`/reports/consecutive-absences?minDays=${minDays}&format=csv`} name="consecutive-absences" />} bodyClass="p-0">
      <div className="no-print border-b border-slate-100 p-3"><Field label="Minimum consecutive days"><Select className="w-40" value={minDays} onChange={setMin} options={['2', '3', '4', '5', '7', '10'].map((x) => ({ value: x, label: `${x}+ days` }))} /></Field></div>
      <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No students match" /> : undefined}>
        <ul className="divide-y divide-slate-100">{q.data?.data.map((r) => <li key={r.studentId} className="flex items-center justify-between px-4 py-2.5 text-sm"><div><Link to={`/students/${r.studentId}`} className="font-medium hover:text-brand-700">{r.name}</Link><div className="text-xs text-slate-500">{r.classLabel} · {r.admissionNumber} · last absent {fmtDate(r.lastAbsent)}</div></div><Badge className="bg-red-100 text-red-800">{r.current} days</Badge></li>)}</ul>
      </QueryState>
    </Card>
  );
}

function Compliance() {
  const [to, setTo] = useState(todayIso());
  const [from, setFrom] = useState(addDaysIso(todayIso(), -6));
  const q = useQuery({ queryKey: ['report', 'compliance', from, to], queryFn: () => api.get<{ totals: { expected: number; submitted: number; pending: number }; staff: { staffId: string | null; staffName: string; expected: number; submitted: number; pending: number; complianceRate: number | null; missing: { date: string; subject: string }[] }[] }>(`/reports/compliance${qs({ from, to })}`) });
  const d = q.data?.data;
  return (
    <Card title={d ? `${d.totals.submitted} of ${d.totals.expected} expected registers submitted` : 'Submission compliance'} actions={<Actions csv={`/reports/compliance${qs({ from, to, format: 'csv' })}`} name="submission-compliance" />} bodyClass="p-0">
      <div className="no-print flex flex-wrap gap-2 border-b border-slate-100 p-3"><input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      <QueryState q={q}>
        <div className="overflow-x-auto"><table className="w-full min-w-[640px]"><thead className="bg-slate-50"><tr><th className="th">Faculty</th><th className="th text-right">Expected</th><th className="th text-right">Submitted</th><th className="th text-right">Pending</th><th className="th text-right">Rate</th><th className="th">Missing (latest)</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{d?.staff.map((s, i) => <tr key={i}><td className="td font-medium">{s.staffName}</td><td className="td text-right tabular-nums">{s.expected}</td><td className="td text-right tabular-nums">{s.submitted}</td><td className="td text-right tabular-nums">{s.pending}</td><td className={`td text-right tabular-nums ${(s.complianceRate ?? 100) < 90 ? 'font-semibold text-red-700' : ''}`}>{fmtPct(s.complianceRate)}</td><td className="td text-xs text-slate-500">{s.missing.slice(-3).map((m) => `${fmtDate(m.date)} ${m.subject}`).join('; ') || '—'}</td></tr>)}</tbody></table></div>
      </QueryState>
    </Card>
  );
}
