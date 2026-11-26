import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { Badge, Button, Card, Empty, PageHeader, Pagination, QueryState, useToast } from '../../components/ui';
import { FormModal } from '../../components/FormModal';

interface G { id: string; fullName: string; email: string | null; phone: string | null; hasLogin: boolean; children: { id: string; name: string; relationship: string }[] }

export default function Guardians() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<{ kind: 'new' | 'login' | 'link'; g?: G } | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['guardians', page, search], queryFn: () => api.get<G[]>(`/guardians${qs({ page, search })}`) });
  const students = useQuery({ queryKey: ['students', 'all-lite'], queryFn: () => api.get<{ id: string; firstName: string; lastName: string; admissionNumber: string }[]>('/students?pageSize=200'), enabled: modal?.kind === 'link' || modal?.kind === 'new' });
  const studentOpts = (students.data?.data ?? []).map((s) => ({ value: s.id, label: `${s.firstName} ${s.lastName} (${s.admissionNumber})` }));
  const refresh = () => qc.invalidateQueries({ queryKey: ['guardians'] });
  return (
    <div>
      <PageHeader title="Guardians" subtitle="Parents and guardians, their linked children and portal access." actions={<Button onClick={() => setModal({ kind: 'new' })}><Plus className="h-4 w-4" />Add guardian</Button>} />
      <Card bodyClass="p-0">
        <div className="border-b border-slate-100 p-3"><input className="input max-w-sm" placeholder="Search name or phone" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
        <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No guardians" /> : undefined}>
          <ul className="divide-y divide-slate-100">{q.data?.data.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1"><div className="text-sm font-medium">{g.fullName}</div><div className="text-xs text-slate-500">{g.phone ?? 'no phone'} · {g.email ?? 'no email'}</div>
                <div className="mt-1 flex flex-wrap gap-1">{g.children.map((c) => <Link key={c.id} to={`/students/${c.id}`}><Badge className="bg-brand-50 text-brand-700">{c.name} · {c.relationship}</Badge></Link>)}</div></div>
              <Button size="sm" variant="ghost" onClick={() => setModal({ kind: 'link', g })}>Link child</Button>
              {g.hasLogin ? <Badge className="bg-emerald-100 text-emerald-800">Portal access</Badge> : <Button size="sm" variant="outline" onClick={() => setModal({ kind: 'login', g })}>Create login</Button>}
            </li>))}</ul>
          <Pagination meta={q.data?.meta as never} onPage={setPage} />
        </QueryState>
      </Card>
      <FormModal open={modal?.kind === 'new'} onClose={() => setModal(null)} title="Add guardian"
        fields={[{ name: 'fullName', label: 'Full name', required: true }, { name: 'phone', label: 'Phone', half: true }, { name: 'email', label: 'Email', type: 'email', half: true }, { name: 'studentId', label: 'Child', type: 'select', options: studentOpts, half: true }, { name: 'relationship', label: 'Relationship', type: 'select', options: ['mother', 'father', 'guardian', 'grandparent', 'other'].map((x) => ({ value: x, label: x })), half: true }]}
        onSubmit={async (v) => { await api.post('/guardians', v); toast.success('Guardian added'); refresh(); }} />
      <FormModal open={modal?.kind === 'link'} onClose={() => setModal(null)} title={`Link a child to ${modal?.g?.fullName}`}
        fields={[{ name: 'studentId', label: 'Student', type: 'select', required: true, options: studentOpts, hint: 'Shows the first 200 students; search on the Students page for others.' }, { name: 'relationship', label: 'Relationship', type: 'select', required: true, options: ['mother', 'father', 'guardian', 'grandparent', 'other'].map((x) => ({ value: x, label: x })) }, { name: 'isPrimary', label: 'Primary contact', type: 'checkbox' }]}
        onSubmit={async (v) => { await api.post(`/guardians/${modal!.g!.id}/links`, v); toast.success('Linked'); refresh(); }} />
      <FormModal open={modal?.kind === 'login'} onClose={() => setModal(null)} title={`Portal login for ${modal?.g?.fullName}`} submitLabel="Create login" initial={{ email: modal?.g?.email ?? '' }}
        fields={[{ name: 'email', label: 'Email', type: 'email', required: true }, { name: 'password', label: 'Initial password', type: 'password', required: true, hint: '10+ characters with letters and numbers.' }]}
        onSubmit={async (v) => { await api.post(`/guardians/${modal!.g!.id}/login`, v); toast.success('Login created'); refresh(); }} />
    </div>
  );
}
