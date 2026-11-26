import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Upload } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Empty, PageHeader, Pagination, QueryState, Select, useToast } from '../../components/ui';
import { FormModal } from '../../components/FormModal';
import { useSectionOptions } from '../../lib/lookups';

interface Row { id: string; admissionNumber: string; firstName: string; lastName: string; status: string; gender: string | null; enrolment: { sectionName: string; classLevelName: string; rollNumber: string | null } | null }

export default function Students() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState(sp.get('search') ?? '');
  const page = Number(sp.get('page') ?? 1);
  const sectionId = sp.get('sectionId') ?? '';
  const status = sp.get('status') ?? '';
  const [create, setCreate] = useState(false);
  const sections = useSectionOptions();
  const q = useQuery({ queryKey: ['students', page, sp.get('search'), sectionId, status], queryFn: () => api.get<Row[]>(`/students${qs({ page, pageSize: 25, search: sp.get('search'), sectionId, status })}`) });
  const upd = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n); };
  return (
    <div>
      <PageHeader title="Students" subtitle={q.data?.meta ? `${q.data.meta.total} students` : undefined}
        actions={can('students.manage') && <>
          {can('students.import') && <Link to="/students/import"><Button variant="outline"><Upload className="h-4 w-4" />Import CSV</Button></Link>}
          <Button onClick={() => setCreate(true)}><Plus className="h-4 w-4" />Add student</Button>
        </>} />
      <Card bodyClass="p-0">
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <form className="relative min-w-[200px] flex-1" onSubmit={(e) => { e.preventDefault(); upd('search', search); }}>
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><input className="input pl-9" placeholder="Name or admission number, then Enter" value={search} onChange={(e) => setSearch(e.target.value)} />
          </form>
          <Select className="w-auto" value={sectionId} onChange={(v) => upd('sectionId', v)} placeholder="All classes" options={sections.options} />
          <Select className="w-auto" value={status} onChange={(v) => upd('status', v)} placeholder="Any status" options={['active', 'inactive', 'withdrawn', 'transferred', 'alumni', 'suspended'].map((s) => ({ value: s, label: s }))} />
        </div>
        <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No students found" hint={sp.get('search') ? 'Try a different search.' : 'Add students one by one or import a CSV.'} /> : undefined}>
          <div className="overflow-x-auto"><table className="w-full min-w-[640px]">
            <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th">Admission no.</th><th className="th">Class</th><th className="th">Roll</th><th className="th">Status</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{q.data?.data.map((s) => (
              <tr key={s.id} className="cursor-pointer hover:bg-slate-50" onClick={() => nav(`/students/${s.id}`)}>
                <td className="td"><Link to={`/students/${s.id}`} className="font-medium text-slate-900 hover:text-brand-700" onClick={(e) => e.stopPropagation()}>{s.firstName} {s.lastName}</Link></td>
                <td className="td tabular-nums">{s.admissionNumber}</td>
                <td className="td">{s.enrolment ? `${s.enrolment.classLevelName} ${s.enrolment.sectionName}` : <span className="text-slate-400">Not enrolled</span>}</td>
                <td className="td tabular-nums">{s.enrolment?.rollNumber ?? '—'}</td>
                <td className="td"><Badge className={s.status === 'active' ? 'bg-emerald-100 text-emerald-800' : ''}>{s.status}</Badge></td>
              </tr>))}</tbody>
          </table></div>
          <Pagination meta={q.data?.meta as never} onPage={(p) => upd('page', String(p))} />
        </QueryState>
      </Card>
      <FormModal open={create} onClose={() => setCreate(false)} title="Add student" wide submitLabel="Add student"
        fields={[
          { name: 'firstName', label: 'First name', required: true, half: true }, { name: 'lastName', label: 'Last name', half: true },
          { name: 'admissionNumber', label: 'Admission number', required: true, half: true }, { name: 'admissionDate', label: 'Admission date', type: 'date', half: true },
          { name: 'dateOfBirth', label: 'Date of birth', type: 'date', half: true }, { name: 'gender', label: 'Gender', type: 'select', options: [{ value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }, { value: 'other', label: 'Other' }], half: true },
          { name: 'sectionId', label: 'Class / section', type: 'select', options: sections.options, half: true }, { name: 'rollNumber', label: 'Roll number', half: true },
          { name: 'phone', label: 'Phone', half: true }, { name: 'email', label: 'Email', type: 'email', half: true },
          { name: 'address', label: 'Address', type: 'textarea' },
          { name: 'loginEmail', label: 'Portal login email (optional)', type: 'email', half: true }, { name: 'loginPassword', label: 'Portal password', type: 'password', half: true, hint: '10+ chars with letters and numbers' },
        ]}
        onSubmit={async (v) => {
          const { sectionId: sec, rollNumber, loginEmail, loginPassword, ...rest } = v as Record<string, string>;
          const r = await api.post<{ id: string }>('/students', { ...rest, ...(sec ? { enrolment: { sectionId: sec, rollNumber: rollNumber || undefined } } : {}), ...(loginEmail ? { login: { email: loginEmail, password: loginPassword } } : {}) });
          toast.success('Student added'); qc.invalidateQueries({ queryKey: ['students'] }); nav(`/students/${r.data.id}`);
        }} />
    </div>
  );
}
