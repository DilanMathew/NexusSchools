import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Empty, Field, Modal, PageHeader, QueryState, Select, useToast } from '../../components/ui';
import { FormModal } from '../../components/FormModal';
import { useYears } from '../../lib/lookups';
import { fmtDate, fmtDateTime, fmtPct, titleCase } from '../../lib/format';

interface Exam { id: string; name: string; yearName: string; attendanceFrom: string; attendanceTo: string; threshold: string; computedAt: string | null; total: number; belowThreshold: number; decided: number }
interface Row { id: string; studentId: string; name: string; admissionNumber: string; classLabel: string; percentage: number | null; meetsThreshold: boolean; status: string; exemptionReason: string | null }
const statusCls: Record<string, string> = { computed: '', exempted: 'bg-sky-100 text-sky-800', confirmed_eligible: 'bg-emerald-100 text-emerald-800', confirmed_ineligible: 'bg-red-100 text-red-800' };

export default function Exams() {
  const { can } = useAuth();
  const [create, setCreate] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const qc = useQueryClient(); const toast = useToast();
  const years = useYears();
  const q = useQuery({ queryKey: ['exams'], queryFn: () => api.get<Exam[]>('/exams') });
  const exam = q.data?.data.find((e) => e.id === sel) ?? q.data?.data[0];
  const compute = useMutation({ mutationFn: (id: string) => api.post<{ students: number; belowThreshold: number }>(`/exams/${id}/compute`), onSuccess: (r) => { toast.success(`Computed for ${r.data.students} students; ${r.data.belowThreshold} below threshold`); qc.invalidateQueries({ queryKey: ['exams'] }); qc.invalidateQueries({ queryKey: ['eligibility'] }); }, onError: (e) => toast.error(e) });
  return (
    <div>
      <PageHeader title="Examination eligibility" subtitle="Attendance-based indicators for each examination. The official decision is recorded separately by an authorised person." actions={can('exams.manage') && <Button onClick={() => setCreate(true)}><Plus className="h-4 w-4" />New examination</Button>} />
      <QueryState q={q} empty={q.data?.data.length === 0 ? <Card><Empty title="No examinations set up" hint="Create one to compute attendance eligibility for its attendance period." /></Card> : undefined}>
        <div className="mb-4 flex flex-wrap gap-2">{q.data?.data.map((e) => <button key={e.id} onClick={() => setSel(e.id)} className={`rounded-lg border px-3 py-2 text-left text-sm ${exam?.id === e.id ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white'}`}><div className="font-medium">{e.name}</div><div className="text-xs text-slate-500">{e.yearName} · {e.total ? `${e.belowThreshold} below ${Number(e.threshold)}%` : 'not computed'}</div></button>)}</div>
        {exam && (
          <Card title={`${exam.name} · attendance ${fmtDate(exam.attendanceFrom)} – ${fmtDate(exam.attendanceTo)} · threshold ${Number(exam.threshold)}%`} actions={<>
            {can('exams.manage') && <Button size="sm" variant="outline" loading={compute.isPending} onClick={() => compute.mutate(exam.id)}><RefreshCw className="h-4 w-4" />{exam.computedAt ? 'Recompute' : 'Compute'}</Button>}
            <Button size="sm" variant="outline" onClick={() => api.download(`/exams/${exam.id}/eligibility?filter=all&format=csv`, 'eligibility.csv')}><Download className="h-4 w-4" />CSV</Button></>} bodyClass="p-0">
            {exam.computedAt ? <EligibilityTable exam={exam} /> : <Empty title="Not computed yet" hint="Compute to see each student's attendance against the threshold." />}
            {exam.computedAt && <p className="px-4 py-2 text-xs text-slate-500">Computed {fmtDateTime(exam.computedAt)}. Recomputing updates figures but never changes exemptions or confirmed decisions.</p>}
          </Card>
        )}
      </QueryState>
      <FormModal open={create} onClose={() => setCreate(false)} title="New examination" initial={{ academicYearId: years.data?.find((y) => y.isCurrent)?.id ?? '' }}
        fields={[{ name: 'name', label: 'Name', required: true, placeholder: 'End-semester examinations' }, { name: 'academicYearId', label: 'Academic year', type: 'select', required: true, options: (years.data ?? []).map((y) => ({ value: y.id, label: y.name })) }, { name: 'attendanceFrom', label: 'Attendance counted from', type: 'date', required: true, half: true }, { name: 'attendanceTo', label: 'to', type: 'date', required: true, half: true }, { name: 'threshold', label: 'Threshold % (blank = policy)', type: 'number', half: true }]}
        onSubmit={async (v) => { const r = await api.post<{ id: string }>('/exams', v); toast.success('Examination created'); setSel(r.data.id); qc.invalidateQueries({ queryKey: ['exams'] }); }} />
    </div>
  );
}

function EligibilityTable({ exam }: { exam: Exam }) {
  const { can } = useAuth();
  const [filter, setFilter] = useState('below');
  const [picked, setPicked] = useState<string[]>([]);
  const [exempt, setExempt] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['eligibility', exam.id, filter], queryFn: () => api.get<Row[]>(`/exams/${exam.id}/eligibility?filter=${filter}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['eligibility'] }); qc.invalidateQueries({ queryKey: ['exams'] }); setPicked([]); };
  const confirm = useMutation({ mutationFn: (decision: string) => api.post<{ updated: number }>(`/exams/${exam.id}/eligibility/confirm`, { studentIds: picked, decision }), onSuccess: (r) => { toast.success(`${r.data.updated} decision(s) recorded`); refresh(); }, onError: (e) => toast.error(e) });
  const doExempt = useMutation({ mutationFn: () => api.post(`/exams/${exam.id}/eligibility/${exempt!.studentId}/exempt`, { reason }), onSuccess: () => { toast.success('Exemption recorded'); setExempt(null); setReason(''); refresh(); }, onError: (e) => toast.error(e) });
  const rows = q.data?.data ?? [];
  const open = rows.filter((r) => r.status === 'computed' || r.status === 'exempted');
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
        <Select className="w-auto" value={filter} onChange={(v) => { setFilter(v); setPicked([]); }} options={[{ value: 'below', label: 'Below threshold' }, { value: 'undecided', label: 'Awaiting decision' }, { value: 'exempted', label: 'Exempted' }, { value: 'all', label: 'All students' }]} />
        {can('exams.confirm') && picked.length > 0 && <><span className="text-sm text-slate-600">{picked.length} selected</span><Button size="sm" variant="success" loading={confirm.isPending} onClick={() => confirm.mutate('confirmed_eligible')}>Confirm eligible</Button><Button size="sm" variant="danger" loading={confirm.isPending} onClick={() => confirm.mutate('confirmed_ineligible')}>Confirm not eligible</Button></>}
      </div>
      <QueryState q={q} empty={!rows.length ? <Empty title="No students in this view" /> : undefined}>
        <div className="overflow-x-auto"><table className="w-full min-w-[720px]"><thead className="bg-slate-50"><tr>{can('exams.confirm') && <th className="th w-8"><input type="checkbox" checked={!!open.length && picked.length === open.length} onChange={(e) => setPicked(e.target.checked ? open.map((r) => r.studentId) : [])} aria-label="Select all" /></th>}<th className="th">Student</th><th className="th">Class</th><th className="th text-right">Attendance</th><th className="th">Indicator</th><th className="th">Status</th><th className="th" /></tr></thead>
          <tbody className="divide-y divide-slate-100">{rows.map((r) => { const editable = r.status === 'computed' || r.status === 'exempted'; return (
            <tr key={r.id}>{can('exams.confirm') && <td className="td">{editable && <input type="checkbox" checked={picked.includes(r.studentId)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.studentId] : p.filter((x) => x !== r.studentId)))} aria-label={`Select ${r.name}`} />}</td>}
              <td className="td font-medium">{r.name}<div className="text-xs text-slate-500">{r.admissionNumber}</div></td><td className="td">{r.classLabel}</td><td className="td text-right tabular-nums">{fmtPct(r.percentage)}</td>
              <td className="td">{r.meetsThreshold ? <Badge className="bg-emerald-100 text-emerald-800">Meets</Badge> : <Badge className="bg-amber-100 text-amber-800">Below</Badge>}</td>
              <td className="td"><Badge className={statusCls[r.status]}>{titleCase(r.status)}</Badge>{r.exemptionReason && <div className="mt-0.5 text-xs text-slate-500">{r.exemptionReason}</div>}</td>
              <td className="td text-right">{can('exams.manage') && r.status === 'computed' && !r.meetsThreshold && <Button size="sm" variant="ghost" onClick={() => setExempt(r)}>Record exemption</Button>}</td></tr>); })}</tbody></table></div>
      </QueryState>
      <Modal open={!!exempt} onClose={() => setExempt(null)} title={`Exemption · ${exempt?.name}`} footer={<><Button variant="outline" onClick={() => setExempt(null)}>Cancel</Button><Button disabled={reason.trim().length < 5} loading={doExempt.isPending} onClick={() => doExempt.mutate()}>Record exemption</Button></>}>
        <Field label="Reason and evidence" hint="e.g. medical certificate verified by the principal."><textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </>
  );
}
