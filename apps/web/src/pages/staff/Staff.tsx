import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Empty, Modal, PageHeader, Pagination, QueryState, Select, useToast } from '../../components/ui';
import { FormModal } from '../../components/FormModal';
import { useDepts } from '../../lib/lookups';

interface S { id: string; employeeId: string; fullName: string; email: string | null; phone: string | null; designation: string | null; departmentId: string | null; departmentName: string | null; employmentStatus: string; joiningDate: string | null; hasLogin: boolean; offeringCount: number; weeklyPeriods: number }
interface Detail extends S { offerings: { id: string; subject: string; subjectCode: string; kind: string; section: string | null; classLevel: string | null }[]; workload: { offerings: number; weeklyPeriods: number } }

export default function Staff() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('');
  const [modal, setModal] = useState<{ kind: 'new' | 'edit'; s?: S } | null>(null);
  const [view, setView] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const depts = useDepts();
  const deptOpts = (depts.data ?? []).map((d) => ({ value: d.id, label: d.name }));
  const q = useQuery({ queryKey: ['staff', page, search, dept], queryFn: () => api.get<S[]>(`/staff${qs({ page, pageSize: 25, search, departmentId: dept })}`) });
  const detail = useQuery({ queryKey: ['staff-detail', view], queryFn: () => api.get<Detail>(`/staff/${view}`), enabled: !!view });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ key: string; name: string }[]>('/roles'), enabled: modal?.kind === 'new' && can('users.manage') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['staff'] });
  const fields = [
    { name: 'fullName', label: 'Full name', required: true }, { name: 'employeeId', label: 'Employee ID', required: true, half: true }, { name: 'designation', label: 'Designation', half: true },
    { name: 'departmentId', label: 'Department', type: 'select' as const, options: deptOpts, half: true }, { name: 'joiningDate', label: 'Joining date', type: 'date' as const, half: true },
    { name: 'phone', label: 'Phone', half: true }, { name: 'email', label: 'Email', type: 'email' as const, half: true },
  ];
  return (
    <div>
      <PageHeader title="Staff" subtitle="Teachers and staff, their departments and teaching load." actions={can('staff.manage') && <Button onClick={() => setModal({ kind: 'new' })}><Plus className="h-4 w-4" />Add staff</Button>} />
      <Card bodyClass="p-0">
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3"><input className="input max-w-xs" placeholder="Search name or employee ID" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /><Select className="w-auto" value={dept} onChange={(v) => { setDept(v); setPage(1); }} placeholder="All departments" options={deptOpts} /></div>
        <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No staff found" /> : undefined}>
          <div className="overflow-x-auto"><table className="w-full min-w-[720px]">
            <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th">Employee ID</th><th className="th">Department</th><th className="th text-right">Classes</th><th className="th text-right">Periods / week</th><th className="th">Login</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{q.data?.data.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="td"><button className="text-left font-medium hover:text-brand-700" onClick={() => setView(s.id)}>{s.fullName}</button><div className="text-xs text-slate-500">{s.designation}</div></td>
                <td className="td tabular-nums">{s.employeeId}</td><td className="td">{s.departmentName ?? '—'}</td>
                <td className="td text-right tabular-nums">{s.offeringCount}</td><td className="td text-right tabular-nums">{s.weeklyPeriods}</td>
                <td className="td">{s.hasLogin ? <Badge className="bg-emerald-100 text-emerald-800">Yes</Badge> : <Badge>No</Badge>}</td>
                <td className="td text-right">{can('staff.manage') && <Button size="sm" variant="ghost" onClick={() => setModal({ kind: 'edit', s })}>Edit</Button>}</td>
              </tr>))}</tbody>
          </table></div>
          <Pagination meta={q.data?.meta as never} onPage={setPage} />
        </QueryState>
      </Card>
      <FormModal open={modal?.kind === 'new'} onClose={() => setModal(null)} title="Add staff member" wide
        fields={[...fields, ...(can('users.manage') ? [{ name: 'loginEmail', label: 'Login email (optional)', type: 'email' as const, half: true }, { name: 'loginPassword', label: 'Initial password', type: 'password' as const, half: true }, { name: 'roleKey', label: 'Role', type: 'select' as const, options: (roles.data?.data ?? []).filter((r) => !['student', 'parent', 'owner'].includes(r.key)).map((r) => ({ value: r.key, label: r.name })), hint: 'Defaults to Faculty' }] : [])]}
        onSubmit={async (v) => { const { loginEmail, loginPassword, roleKey, ...rest } = v as Record<string, string>; await api.post('/staff', { ...rest, ...(loginEmail ? { login: { email: loginEmail, password: loginPassword, roleKeys: [roleKey || 'faculty'] } } : {}) }); toast.success('Staff member added'); refresh(); }} />
      <FormModal open={modal?.kind === 'edit'} onClose={() => setModal(null)} title="Edit staff member" wide initial={modal?.s ? { fullName: modal.s.fullName, employeeId: modal.s.employeeId, designation: modal.s.designation ?? '', departmentId: modal.s.departmentId ?? '', joiningDate: modal.s.joiningDate ?? '', phone: modal.s.phone ?? '', email: modal.s.email ?? '', employmentStatus: modal.s.employmentStatus } : undefined}
        fields={[...fields, { name: 'employmentStatus', label: 'Employment status', type: 'select', options: ['active', 'on_leave', 'resigned', 'retired', 'inactive'].map((x) => ({ value: x, label: x })) }]}
        onSubmit={async (v) => { await api.patch(`/staff/${modal!.s!.id}`, v); toast.success('Saved'); refresh(); }} />
      <Modal open={!!view} onClose={() => setView(null)} title={detail.data?.data.fullName ?? 'Staff member'} wide>
        <QueryState q={detail}>
          {detail.data && (
            <div className="space-y-3 text-sm">
              <p>{detail.data.data.designation} · {detail.data.data.email ?? 'no email'} · {detail.data.data.phone ?? 'no phone'}</p>
              <p><b>Workload:</b> {detail.data.data.workload.offerings} classes, {detail.data.data.workload.weeklyPeriods} periods per week</p>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">{detail.data.data.offerings.map((o) => <li key={o.id} className="flex justify-between px-3 py-2"><span>{o.subject} <span className="text-slate-500">({o.subjectCode})</span></span><span className="text-slate-500">{o.classLevel} {o.section} · {o.kind}</span></li>)}{!detail.data.data.offerings.length && <li className="px-3 py-2 text-slate-500">No classes assigned</li>}</ul>
            </div>
          )}
        </QueryState>
      </Modal>
    </div>
  );
}
