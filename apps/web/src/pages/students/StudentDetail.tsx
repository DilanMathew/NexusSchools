import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, IdCard, Pencil, UserPlus } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Confirm, PageHeader, QueryState, Tabs, useToast } from '../../components/ui';
import { FormModal } from '../../components/FormModal';
import { useSectionOptions } from '../../lib/lookups';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { StudentAttendance } from '../portal/MyAttendance';

interface Detail {
  id: string; admissionNumber: string; firstName: string; lastName: string; dateOfBirth: string | null; gender: string | null; admissionDate: string | null; status: string;
  email?: string | null; phone?: string | null; address?: string | null; emergencyContact?: { name?: string; phone?: string; relationship?: string } | null; medicalNotes?: string | null; previousInstitution: string | null; hasLogin: boolean;
  enrolments: { id: string; yearName: string; sectionId: string; sectionName: string; classLevelName: string; rollNumber: string | null; isActive: boolean }[];
  guardians: { id: string; fullName: string; phone: string | null; email: string | null; relationship: string; isPrimary: boolean; hasLogin: boolean }[];
  statusHistory: { id: string; fromStatus: string | null; toStatus: string; reason: string | null; createdAt: string }[];
}

export default function StudentDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [tab, setTab] = useState<'attendance' | 'profile' | 'guardians' | 'history'>('attendance');
  const [modal, setModal] = useState<'edit' | 'status' | 'section' | 'login' | 'guardian' | 'delete' | null>(null);
  const sections = useSectionOptions();
  const q = useQuery({ queryKey: ['student', id], queryFn: () => api.get<Detail>(`/students/${id}`) });
  const s = q.data?.data;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['student', id] }); qc.invalidateQueries({ queryKey: ['students'] }); };
  const manage = can('students.manage');
  const current = s?.enrolments.find((e) => e.isActive);
  return (
    <div>
      <Link to="/students" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" />Students</Link>
      <QueryState q={q}>
        {s && (
          <>
            <PageHeader title={`${s.firstName} ${s.lastName}`} subtitle={<span>{s.admissionNumber}{current && ` · ${current.classLevelName} ${current.sectionName}${current.rollNumber ? ` · Roll ${current.rollNumber}` : ''}`} · <Badge className={s.status === 'active' ? 'bg-emerald-100 text-emerald-800' : ''}>{s.status}</Badge></span>}
              actions={manage && <>
                <Button variant="outline" onClick={() => setModal('edit')}><Pencil className="h-4 w-4" />Edit</Button>
                <Button variant="outline" onClick={() => setModal('section')}>Change section</Button>
                <Button variant="outline" onClick={() => setModal('status')}>Change status</Button>
                <Link to={`/students/${s.id}/id-card`} target="_blank"><Button variant="outline"><IdCard className="h-4 w-4" />ID card</Button></Link>
                <Button variant="outline" onClick={async () => { await api.post(`/students/${s.id}/id-card/reissue`); toast.success('ID card reissued; the old card QR no longer works'); }}>Reissue card</Button>
                {!s.hasLogin && <Button variant="outline" onClick={() => setModal('login')}><UserPlus className="h-4 w-4" />Create login</Button>}
              </>} />
            <Tabs value={tab} onChange={setTab} tabs={[{ key: 'attendance', label: 'Attendance' }, { key: 'profile', label: 'Profile' }, { key: 'guardians', label: `Guardians (${s.guardians.length})` }, { key: 'history', label: 'Enrolment & status' }]} />
            {tab === 'attendance' && <StudentAttendance studentId={s.id} />}
            {tab === 'profile' && (
              <Card>
                <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                  {([['Date of birth', fmtDate(s.dateOfBirth)], ['Gender', s.gender], ['Admission date', fmtDate(s.admissionDate)], ['Previous institution', s.previousInstitution], ['Phone', s.phone], ['Email', s.email], ['Address', s.address], ['Emergency contact', s.emergencyContact ? `${s.emergencyContact.name ?? ''} ${s.emergencyContact.phone ?? ''} (${s.emergencyContact.relationship ?? ''})` : null], ['Portal login', s.hasLogin ? 'Yes' : 'No']] as [string, string | null | undefined][])
                    .filter(([, v]) => v !== undefined).map(([k, v]) => <div key={k}><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt><dd className="mt-0.5 text-sm">{v || '—'}</dd></div>)}
                  {s.medicalNotes !== undefined && <div className="sm:col-span-2"><dt className="text-xs font-medium uppercase tracking-wide text-red-600">Medical / emergency notes (restricted)</dt><dd className="mt-0.5 text-sm">{s.medicalNotes || '—'}</dd></div>}
                </dl>
                {s.email === undefined && <p className="mt-4 text-xs text-slate-500">Contact details are hidden for your role.</p>}
                {manage && <div className="mt-6 border-t border-slate-100 pt-4"><Button variant="ghost" className="text-red-600" onClick={() => setModal('delete')}>Delete student record</Button></div>}
              </Card>
            )}
            {tab === 'guardians' && (
              <Card title="Guardians" actions={can('guardians.manage') && <Button size="sm" onClick={() => setModal('guardian')}>Add guardian</Button>} bodyClass="p-0">
                {!s.guardians.length ? <p className="p-4 text-sm text-slate-500">No guardians linked, or contact details are hidden for your role.</p> : (
                  <ul className="divide-y divide-slate-100">{s.guardians.map((g) => <li key={g.id} className="flex items-center justify-between px-4 py-3 text-sm"><div><div className="font-medium">{g.fullName} {g.isPrimary && <Badge className="ml-1 bg-brand-100 text-brand-700">Primary</Badge>}</div><div className="text-slate-500">{g.relationship} · {g.phone ?? 'no phone'} · {g.email ?? 'no email'}</div></div><Badge>{g.hasLogin ? 'Has login' : 'No login'}</Badge></li>)}</ul>
                )}
              </Card>
            )}
            {tab === 'history' && (
              <div className="grid gap-5 md:grid-cols-2">
                <Card title="Enrolments" bodyClass="p-0"><ul className="divide-y divide-slate-100">{s.enrolments.map((e) => <li key={e.id} className="flex justify-between px-4 py-2.5 text-sm"><span>{e.yearName} · {e.classLevelName} {e.sectionName}{e.rollNumber && ` · Roll ${e.rollNumber}`}</span>{e.isActive ? <Badge className="bg-emerald-100 text-emerald-800">Current</Badge> : <Badge>Ended</Badge>}</li>)}</ul></Card>
                <Card title="Status history" bodyClass="p-0"><ul className="divide-y divide-slate-100">{s.statusHistory.map((h) => <li key={h.id} className="px-4 py-2.5 text-sm"><div>{h.fromStatus ? `${h.fromStatus} → ` : ''}<b>{h.toStatus}</b></div><div className="text-xs text-slate-500">{h.reason} · {fmtDateTime(h.createdAt)}</div></li>)}</ul></Card>
              </div>
            )}

            <FormModal open={modal === 'edit'} onClose={() => setModal(null)} title="Edit student" wide initial={{ firstName: s.firstName, lastName: s.lastName, dateOfBirth: s.dateOfBirth ?? '', gender: s.gender ?? '', admissionDate: s.admissionDate ?? '', phone: s.phone ?? '', email: s.email ?? '', address: s.address ?? '', previousInstitution: s.previousInstitution ?? '', ...(s.medicalNotes !== undefined ? { medicalNotes: s.medicalNotes ?? '' } : {}) }}
              fields={[{ name: 'firstName', label: 'First name', required: true, half: true }, { name: 'lastName', label: 'Last name', half: true }, { name: 'dateOfBirth', label: 'Date of birth', type: 'date', half: true }, { name: 'gender', label: 'Gender', type: 'select', options: [{ value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }, { value: 'other', label: 'Other' }], half: true }, { name: 'admissionDate', label: 'Admission date', type: 'date', half: true }, { name: 'previousInstitution', label: 'Previous institution', half: true }, { name: 'phone', label: 'Phone', half: true }, { name: 'email', label: 'Email', type: 'email', half: true }, { name: 'address', label: 'Address', type: 'textarea' }, ...(s.medicalNotes !== undefined ? [{ name: 'medicalNotes', label: 'Medical / emergency notes (restricted)', type: 'textarea' as const }] : [])]}
              onSubmit={async (v) => { await api.patch(`/students/${s.id}`, { ...v, lastName: v.lastName ?? '' }); toast.success('Saved'); refresh(); }} />
            <FormModal open={modal === 'status'} onClose={() => setModal(null)} title="Change status" initial={{ status: s.status }}
              fields={[{ name: 'status', label: 'Status', type: 'select', required: true, options: ['active', 'inactive', 'withdrawn', 'transferred', 'alumni', 'suspended'].map((x) => ({ value: x, label: x })) }, { name: 'reason', label: 'Reason', type: 'textarea', required: true, hint: 'Withdrawn/transferred/alumni ends the current enrolment.' }]}
              onSubmit={async (v) => { await api.post(`/students/${s.id}/status`, v); toast.success('Status updated'); refresh(); }} />
            <FormModal open={modal === 'section'} onClose={() => setModal(null)} title="Change section" initial={{ sectionId: current?.sectionId ?? '', rollNumber: current?.rollNumber ?? '' }}
              fields={[{ name: 'sectionId', label: 'New section', type: 'select', required: true, options: sections.options }, { name: 'rollNumber', label: 'Roll number', half: true }, { name: 'effectiveDate', label: 'Effective from', type: 'date', half: true }]}
              onSubmit={async (v) => { await api.post(`/students/${s.id}/enrolment`, v); toast.success('Section changed; history kept'); refresh(); }} />
            <FormModal open={modal === 'login'} onClose={() => setModal(null)} title="Create student portal login" submitLabel="Create login"
              fields={[{ name: 'email', label: 'Email', type: 'email', required: true }, { name: 'password', label: 'Initial password', type: 'password', required: true, hint: '10+ characters with letters and numbers. Share it securely.' }]}
              onSubmit={async (v) => { await api.post(`/students/${s.id}/login`, v); toast.success('Login created'); refresh(); }} />
            <FormModal open={modal === 'guardian'} onClose={() => setModal(null)} title="Add guardian"
              fields={[{ name: 'fullName', label: 'Full name', required: true }, { name: 'relationship', label: 'Relationship', type: 'select', required: true, options: ['mother', 'father', 'guardian', 'grandparent', 'sibling', 'other'].map((x) => ({ value: x, label: x })), half: true }, { name: 'phone', label: 'Phone', half: true }, { name: 'email', label: 'Email', type: 'email' }]}
              onSubmit={async (v) => { await api.post('/guardians', { ...v, studentId: s.id }); toast.success('Guardian added'); refresh(); }} />
            <Confirm open={modal === 'delete'} onClose={() => setModal(null)} danger title="Delete student record?" confirmLabel="Delete" message="The record is hidden from lists (soft delete). Attendance history is kept for audit." onConfirm={async () => { await api.delete(`/students/${s.id}`); toast.success('Student deleted'); refresh(); nav('/students'); }} />
          </>
        )}
      </QueryState>
    </div>
  );
}
