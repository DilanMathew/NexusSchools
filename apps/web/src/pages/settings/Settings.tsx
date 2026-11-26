import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Download, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { STATUS_META, type AttendanceStatus } from '../../lib/types';
import { Badge, Button, Card, Empty, Field, Modal, PageHeader, Pagination, QueryState, Select, Tabs, useToast } from '../../components/ui';
import { FormModal } from '../../components/FormModal';
import { fmtDate, fmtDateTime, titleCase } from '../../lib/format';
import { DevicesSettings } from './Devices';

type Tab = 'setup' | 'institution' | 'policy' | 'users' | 'roles' | 'devices' | 'audit' | 'account';
interface Inst { id: string; name: string; type: string; slug: string; logoUrl: string | null; primaryColor: string; timezone: string; locale: string; contactEmail: string | null; contactPhone: string | null; address: string | null; isDemo: boolean;
  settings: { modules: Record<string, boolean>; terminology: Record<string, string>; notificationSettings: Record<string, unknown>; workingDays: number[] }; branches: { id: string; name: string; code: string; isMain: boolean }[];
  subscription: { status: string; planName: string; planCode: string; endsAt: string | null; trialEndsAt: string | null; limits: Record<string, number>; features: string[] } | null }

export default function Settings() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: 'setup', label: 'Setup checklist', show: can('institution.manage') },
    { key: 'institution', label: 'Institution', show: can('institution.manage') },
    { key: 'policy', label: 'Attendance policy', show: true },
    { key: 'users', label: 'Users', show: can('users.read', 'users.manage') },
    { key: 'roles', label: 'Roles & permissions', show: can('roles.read', 'roles.manage') },
    { key: 'devices', label: 'Devices & cards', show: can('devices.manage') },
    { key: 'audit', label: 'Audit log', show: can('audit.read') },
    { key: 'account', label: 'My account', show: true },
  ];
  const visible = tabs.filter((t) => t.show);
  const tab = (visible.find((t) => t.key === sp.get('tab'))?.key ?? visible[0].key) as Tab;
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t })} tabs={visible} />
      {tab === 'setup' && <SetupChecklist />}
      {tab === 'institution' && <InstitutionSettings />}
      {tab === 'policy' && <PolicySettings />}
      {tab === 'users' && <UsersSettings />}
      {tab === 'roles' && <RolesSettings />}
      {tab === 'devices' && <DevicesSettings />}
      {tab === 'audit' && <AuditLog />}
      {tab === 'account' && <Account />}
    </div>
  );
}

function SetupChecklist() {
  const count = (path: string) => useQuery({ queryKey: ['setup', path], queryFn: async () => ((await api.get<unknown[]>(path)).meta as { total: number }).total });
  const steps = [
    { label: 'Create the current academic year', q: count('/academic/years?pageSize=1'), to: '/academics' },
    { label: 'Add departments', q: count('/academic/departments?pageSize=1'), to: '/academics' },
    { label: 'Add classes / years of study', q: count('/academic/class-levels?pageSize=1'), to: '/academics' },
    { label: 'Set the bell schedule (periods)', q: count('/academic/periods?pageSize=1'), to: '/academics' },
    { label: 'Add staff and give them logins', q: count('/staff?pageSize=1'), to: '/staff' },
    { label: 'Create sections with class teachers', q: count('/academic/sections?pageSize=1'), to: '/academics' },
    { label: 'Add subjects and allocate them to faculty', q: count('/academic/offerings?pageSize=1'), to: '/academics' },
    { label: 'Add or import students', q: count('/students?pageSize=1'), to: '/students/import' },
    { label: 'Build the timetable', q: count('/academic/periods?pageSize=1'), to: '/timetable' },
  ];
  return (
    <Card title="Get your institution ready" bodyClass="p-0">
      <ol className="divide-y divide-slate-100">{steps.map((s, i) => { const done = (s.q.data ?? 0) > 0; return (
        <li key={i} className="flex items-center gap-3 px-4 py-3">{done ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <Circle className="h-5 w-5 text-slate-300" />}<span className="flex-1 text-sm">{s.label}{done && <span className="ml-2 text-xs text-slate-500">({s.q.data})</span>}</span><Link to={s.to}><Button size="sm" variant={done ? 'ghost' : 'outline'}>{done ? 'Review' : 'Start'}</Button></Link></li>); })}</ol>
      <p className="px-4 py-3 text-xs text-slate-500">Then review the attendance policy so percentages follow your rules.</p>
    </Card>
  );
}

const MODULE_LABELS: Record<string, string> = { dailyAttendance: 'Daily register (whole-day attendance)', periodAttendance: 'Period-wise attendance', subjectAttendance: 'Subject-wise attendance', assemblyAttendance: 'Assembly attendance', labAttendance: 'Lab / practical sessions', electives: 'Electives with individual enrolment', examEligibility: 'Exam eligibility indicators', qrAttendance: 'QR attendance', rfidAttendance: 'RFID / NFC devices', locationAttendance: 'Location-assisted attendance', offlineAttendance: 'Offline attendance for teachers', parentPortal: 'Parent portal', studentPortal: 'Student portal', campusEntry: 'Campus entry / exit', aiInsights: 'Insights & assistant' };

function InstitutionSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { reload } = useAuth();
  const q = useQuery({ queryKey: ['institution'], queryFn: () => api.get<Inst>('/institution/current') });
  const [edit, setEdit] = useState(false);
  const [branch, setBranch] = useState(false);
  const d = q.data?.data;
  const mod = useMutation({ mutationFn: (m: Record<string, unknown>) => api.patch('/institution/current/settings', m), onSuccess: () => { toast.success('Settings saved'); qc.invalidateQueries({ queryKey: ['institution'] }); }, onError: (e) => toast.error(e) });
  return (
    <QueryState q={q}>
      {d && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Profile & branding" actions={<Button size="sm" variant="outline" onClick={() => setEdit(true)}>Edit</Button>}>
            <div className="flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-lg text-lg font-bold text-white" style={{ background: d.primaryColor }}>{d.logoUrl ? <img src={d.logoUrl} alt="" className="h-full w-full rounded-lg object-contain" /> : d.name[0]}</div><div><div className="font-semibold">{d.name}</div><div className="text-sm text-slate-500">{titleCase(d.type)} · {d.timezone} · {d.locale === 'ta' ? 'Tamil' : 'English'}</div></div></div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-slate-500">Email</dt><dd>{d.contactEmail ?? '—'}</dd></div><div><dt className="text-xs text-slate-500">Phone</dt><dd>{d.contactPhone ?? '—'}</dd></div><div className="col-span-2"><dt className="text-xs text-slate-500">Address</dt><dd>{d.address ?? '—'}</dd></div></dl>
          </Card>
          <Card title="Subscription">
            {d.subscription ? <div className="space-y-2 text-sm"><div className="flex items-center gap-2"><span className="text-lg font-semibold">{d.subscription.planName}</span><Badge className={d.subscription.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}>{d.subscription.status}</Badge></div>
              {d.subscription.trialEndsAt && <p>Trial ends {fmtDate(d.subscription.trialEndsAt)}</p>}
              <p className="text-slate-600">Up to {d.subscription.limits.maxStudents?.toLocaleString('en-IN')} students, {d.subscription.limits.maxStaff} staff, {d.subscription.limits.maxBranches} campus(es).</p>
              <p className="text-xs text-slate-500">Plan changes are handled by the NEXUS team; online payment is not yet available.</p></div> : <p className="text-sm text-slate-500">No subscription on record.</p>}
          </Card>
          <Card title="Modules" className="lg:col-span-2">
            <div className="grid gap-2 sm:grid-cols-2">{Object.keys(MODULE_LABELS).map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!d.settings.modules[k]} onChange={(e) => mod.mutate({ modules: { [k]: e.target.checked } })} />{MODULE_LABELS[k]}</label>))}</div>
            <p className="mt-3 text-xs text-slate-500">RFID/NFC and location-assisted attendance need device integrations that are not yet available; enabling them has no effect yet.</p>
          </Card>
          <Card title="Working days & notifications">
            <div className="mb-4 flex flex-wrap gap-2">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((dn, i) => { const on = d.settings.workingDays.includes(i + 1); return <button key={dn} onClick={() => mod.mutate({ workingDays: on ? d.settings.workingDays.filter((x) => x !== i + 1) : [...d.settings.workingDays, i + 1] })} className={`rounded-lg px-3 py-1.5 text-sm ${on ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600'}`}>{dn}</button>; })}</div>
            {(['notifyAbsent', 'notifyLate'] as const).map((k) => <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={(d.settings.notificationSettings[k] as boolean | undefined) !== false} onChange={(e) => mod.mutate({ notificationSettings: { [k]: e.target.checked } })} />{k === 'notifyAbsent' ? 'Notify guardians when a student is marked absent' : 'Notify guardians when a student is marked late'}</label>)}
            <p className="mt-3 text-xs text-slate-500">In-app notifications are delivered now. Email, SMS and WhatsApp need provider credentials configured for your deployment; until then those deliveries are logged as skipped.</p>
          </Card>
          <Card title="Campuses / branches" actions={<Button size="sm" variant="outline" onClick={() => setBranch(true)}><Plus className="h-4 w-4" />Add</Button>}>
            <ul className="space-y-1 text-sm">{d.branches.map((b) => <li key={b.id} className="flex justify-between"><span>{b.name} <span className="text-slate-500">({b.code})</span></span>{b.isMain && <Badge>Main</Badge>}</li>)}</ul>
            <div className="mt-4 border-t border-slate-100 pt-3"><Button size="sm" variant="outline" onClick={() => api.download('/institution/current/export', `${d.slug}-export.json`)}><Download className="h-4 w-4" />Export institution data (JSON)</Button></div>
          </Card>
          <FormModal open={edit} onClose={() => setEdit(false)} title="Edit institution" wide initial={{ name: d.name, logoUrl: d.logoUrl ?? '', primaryColor: d.primaryColor, timezone: d.timezone, locale: d.locale, contactEmail: d.contactEmail ?? '', contactPhone: d.contactPhone ?? '', address: d.address ?? '' }}
            fields={[{ name: 'name', label: 'Name', required: true }, { name: 'logoUrl', label: 'Logo URL (https)', half: true }, { name: 'primaryColor', label: 'Brand colour', type: 'color', half: true }, { name: 'timezone', label: 'Time zone', half: true }, { name: 'locale', label: 'Default language', type: 'select', options: [{ value: 'en', label: 'English' }, { value: 'ta', label: 'Tamil' }], half: true }, { name: 'contactEmail', label: 'Contact email', type: 'email', half: true }, { name: 'contactPhone', label: 'Contact phone', half: true }, { name: 'address', label: 'Address', type: 'textarea' }]}
            onSubmit={async (v) => { await api.patch('/institution/current', v); toast.success('Saved'); qc.invalidateQueries({ queryKey: ['institution'] }); reload(); }} />
          <FormModal open={branch} onClose={() => setBranch(false)} title="Add campus" fields={[{ name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Code', required: true, half: true }, { name: 'address', label: 'Address', type: 'textarea' }]}
            onSubmit={async (v) => { await api.post('/institution/current/branches', v); toast.success('Campus added'); qc.invalidateQueries({ queryKey: ['institution'] }); }} />
        </div>
      )}
    </QueryState>
  );
}

interface Policy { id: string; version: number; calculationUnit: string; enabledStatuses: AttendanceStatus[]; lateWeight: string; halfDayWeight: string; onDutyCountsAsPresent: boolean; approvedLeaveHandling: string; medicalLeaveHandling: string; excusedHandling: string; excludeHolidays: boolean; separateLabAndTheory: boolean; eligibilityThreshold: string; warningThreshold: string; submissionDeadlineMinutes: number; teacherEditWindowMinutes: number; updatedAt: string }

function PolicySettings() {
  const { can } = useAuth();
  const editable = can('attendance.policy.manage');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['policy'], queryFn: () => api.get<Policy>('/attendance/policy') });
  const [p, setP] = useState<Policy | null>(null);
  useEffect(() => { if (q.data) setP(q.data.data); }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.put('/attendance/policy', { calculationUnit: p!.calculationUnit, enabledStatuses: p!.enabledStatuses, lateWeight: Number(p!.lateWeight), halfDayWeight: Number(p!.halfDayWeight), onDutyCountsAsPresent: p!.onDutyCountsAsPresent, approvedLeaveHandling: p!.approvedLeaveHandling, medicalLeaveHandling: p!.medicalLeaveHandling, excusedHandling: p!.excusedHandling, excludeHolidays: p!.excludeHolidays, separateLabAndTheory: p!.separateLabAndTheory, eligibilityThreshold: Number(p!.eligibilityThreshold), warningThreshold: Number(p!.warningThreshold), submissionDeadlineMinutes: Number(p!.submissionDeadlineMinutes), teacherEditWindowMinutes: Number(p!.teacherEditWindowMinutes) }),
    onSuccess: () => { toast.success('Policy saved as a new version'); qc.invalidateQueries(); }, onError: (e) => toast.error(e),
  });
  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => setP((x) => (x ? { ...x, [k]: v } : x));
  const handling = [{ value: 'exclude', label: 'Exclude from calculation' }, { value: 'present', label: 'Count as present' }, { value: 'absent', label: 'Count as absent' }];
  return (
    <QueryState q={q}>
      {p && (
        <Card title={`Attendance calculation policy · version ${p.version}`} actions={editable && <Button loading={save.isPending} onClick={() => save.mutate()}>Save new version</Button>}>
          <fieldset disabled={!editable} className="grid gap-5 md:grid-cols-2">
            <Field label="Calculate attendance by"><Select value={p.calculationUnit} onChange={(v) => set('calculationUnit', v)} options={[{ value: 'session', label: 'Sessions / periods' }, { value: 'day', label: 'Days (all sessions of a day averaged)' }]} /></Field>
            <div className="grid grid-cols-2 gap-3"><Field label="Eligibility threshold %"><input type="number" className="input" min={0} max={100} value={p.eligibilityThreshold} onChange={(e) => set('eligibilityThreshold', e.target.value)} /></Field><Field label="Warning below %"><input type="number" className="input" min={0} max={100} value={p.warningThreshold} onChange={(e) => set('warningThreshold', e.target.value)} /></Field></div>
            <Field label="Late counts as" hint="1 = fully present, 0.5 = half, 0 = absent"><input type="number" step="0.25" min={0} max={1} className="input" value={p.lateWeight} onChange={(e) => set('lateWeight', e.target.value)} /></Field>
            <Field label="Half-day counts as"><input type="number" step="0.25" min={0} max={1} className="input" value={p.halfDayWeight} onChange={(e) => set('halfDayWeight', e.target.value)} /></Field>
            <Field label="Approved leave"><Select value={p.approvedLeaveHandling} onChange={(v) => set('approvedLeaveHandling', v)} options={handling} /></Field>
            <Field label="Medical leave"><Select value={p.medicalLeaveHandling} onChange={(v) => set('medicalLeaveHandling', v)} options={handling} /></Field>
            <Field label="Excused absence"><Select value={p.excusedHandling} onChange={(v) => set('excusedHandling', v)} options={handling} /></Field>
            <div className="space-y-2 pt-6 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={p.onDutyCountsAsPresent} onChange={(e) => set('onDutyCountsAsPresent', e.target.checked)} />On duty (OD) counts as present</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={p.excludeHolidays} onChange={(e) => set('excludeHolidays', e.target.checked)} />Exclude holidays</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={p.separateLabAndTheory} onChange={(e) => set('separateLabAndTheory', e.target.checked)} />Show lab and theory separately</label>
            </div>
            <Field label="Submission deadline (minutes after the session starts)"><input type="number" className="input" value={p.submissionDeadlineMinutes} onChange={(e) => set('submissionDeadlineMinutes', Number(e.target.value))} /></Field>
            <Field label="Teacher edit window after submitting (minutes)" hint="After this, changes need a correction approval."><input type="number" className="input" value={p.teacherEditWindowMinutes} onChange={(e) => set('teacherEditWindowMinutes', Number(e.target.value))} /></Field>
            <div className="md:col-span-2"><span className="label">Statuses teachers can use</span><div className="flex flex-wrap gap-2">{(['present', 'absent', 'late', 'half_day', 'on_leave', 'excused', 'medical_leave', 'on_duty'] as AttendanceStatus[]).map((s) => { const on = p.enabledStatuses.includes(s); const locked = s === 'present' || s === 'absent'; return <button type="button" key={s} disabled={locked || !editable} onClick={() => set('enabledStatuses', on ? p.enabledStatuses.filter((x) => x !== s) : [...p.enabledStatuses, s])} className={`rounded-full border px-3 py-1 text-sm ${on ? STATUS_META[s].cls : 'border-slate-200 bg-white text-slate-400'}`}>{STATUS_META[s].label}</button>; })}</div></div>
          </fieldset>
          <p className="mt-4 text-xs text-slate-500">Saving creates a new version; the change and the previous values are recorded in the audit log. Reports show which version they used. Last changed {fmtDateTime(p.updatedAt)}.</p>
        </Card>
      )}
    </QueryState>
  );
}

interface U { membershipId: string; status: string; userId: string; email: string; fullName: string; lastLoginAt: string | null; roles: { id: string; key: string; name: string }[] }
interface R { id: string; key: string; name: string; description: string | null; isSystem: boolean; permissions: string[]; memberCount: number }

function UsersSettings() {
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [modal, setModal] = useState<{ kind: 'new' | 'roles' | 'reset'; u?: U } | null>(null);
  const q = useQuery({ queryKey: ['users', page, search, role], queryFn: () => api.get<U[]>(`/users?page=${page}&search=${encodeURIComponent(search)}${role ? `&role=${role}` : ''}`) });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<R[]>('/roles') });
  const roleOpts = (roles.data?.data ?? []).map((r) => ({ value: r.id, label: r.name }));
  const status = useMutation({ mutationFn: (v: { id: string; status: string }) => api.patch(`/users/${v.id}`, { status: v.status }), onSuccess: () => { toast.success('Updated'); qc.invalidateQueries({ queryKey: ['users'] }); }, onError: (e) => toast.error(e) });
  const manage = can('users.manage');
  return (
    <Card bodyClass="p-0" title="User accounts" actions={manage && <Button size="sm" onClick={() => setModal({ kind: 'new' })}><Plus className="h-4 w-4" />Add user</Button>}>
      <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3"><input className="input max-w-xs" placeholder="Search name or email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /><Select className="w-auto" value={role} onChange={(v) => { setRole(v); setPage(1); }} placeholder="All roles" options={(roles.data?.data ?? []).map((r) => ({ value: r.key, label: r.name }))} /></div>
      <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No users" /> : undefined}>
        <div className="overflow-x-auto"><table className="w-full min-w-[720px]"><thead className="bg-slate-50"><tr><th className="th">User</th><th className="th">Roles</th><th className="th">Last login</th><th className="th">Status</th><th className="th" /></tr></thead>
          <tbody className="divide-y divide-slate-100">{q.data?.data.map((u) => (
            <tr key={u.membershipId}><td className="td"><div className="font-medium">{u.fullName}</div><div className="text-xs text-slate-500">{u.email}</div></td><td className="td"><div className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r.id}>{r.name}</Badge>)}</div></td><td className="td text-xs">{fmtDateTime(u.lastLoginAt)}</td>
              <td className="td"><Badge className={u.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}>{u.status}</Badge></td>
              <td className="td whitespace-nowrap text-right">{manage && u.userId !== user?.id && <><Button size="sm" variant="ghost" onClick={() => setModal({ kind: 'roles', u })}>Roles</Button><Button size="sm" variant="ghost" onClick={() => setModal({ kind: 'reset', u })}>Reset password</Button><Button size="sm" variant="ghost" onClick={() => status.mutate({ id: u.membershipId, status: u.status === 'active' ? 'disabled' : 'active' })}>{u.status === 'active' ? 'Disable' : 'Enable'}</Button></>}</td></tr>))}</tbody></table></div>
        <Pagination meta={q.data?.meta as never} onPage={setPage} />
      </QueryState>
      <FormModal open={modal?.kind === 'new'} onClose={() => setModal(null)} title="Add user" wide fields={[{ name: 'fullName', label: 'Full name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true, half: true }, { name: 'password', label: 'Initial password', type: 'password', half: true, hint: 'Not needed if they already have an AttendIQ account.' }, { name: 'roleIds', label: 'Roles', type: 'multiselect', required: true, options: roleOpts }]}
        onSubmit={async (v) => { await api.post('/users', v); toast.success('User added'); qc.invalidateQueries({ queryKey: ['users'] }); }} />
      <FormModal open={modal?.kind === 'roles'} onClose={() => setModal(null)} title={`Roles · ${modal?.u?.fullName}`} initial={{ roleIds: modal?.u?.roles.map((r) => r.id) ?? [] }} fields={[{ name: 'roleIds', label: 'Roles', type: 'multiselect', options: roleOpts, hint: 'You can only grant permissions you hold yourself.' }]}
        onSubmit={async (v) => { await api.patch(`/users/${modal!.u!.membershipId}`, { roleIds: v.roleIds ?? [] }); toast.success('Roles updated'); qc.invalidateQueries({ queryKey: ['users'] }); }} />
      <FormModal open={modal?.kind === 'reset'} onClose={() => setModal(null)} title={`Reset password · ${modal?.u?.fullName}`} submitLabel="Set password" fields={[{ name: 'password', label: 'New temporary password', type: 'password', required: true, hint: 'They are signed out everywhere. Share it securely and ask them to change it.' }]}
        onSubmit={async (v) => { await api.post(`/users/${modal!.u!.membershipId}/reset-password`, v); toast.success('Password reset'); }} />
    </Card>
  );
}

function RolesSettings() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<R[]>('/roles') });
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<{ code: string; module: string; description: string }[]>('/roles/permissions') });
  const [edit, setEdit] = useState<R | 'new' | null>(null);
  const [name, setName] = useState(''); const [desc, setDesc] = useState(''); const [sel, setSel] = useState<string[]>([]);
  useEffect(() => { if (edit && edit !== 'new') { setName(edit.name); setDesc(edit.description ?? ''); setSel(edit.permissions); } else if (edit === 'new') { setName(''); setDesc(''); setSel([]); } }, [edit]);
  const save = useMutation({ mutationFn: () => (edit === 'new' ? api.post('/roles', { name, description: desc, permissions: sel }) : api.put(`/roles/${(edit as R).id}`, { name, description: desc, permissions: sel })), onSuccess: () => { toast.success('Role saved'); qc.invalidateQueries({ queryKey: ['roles'] }); setEdit(null); }, onError: (e) => toast.error(e) });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/roles/${id}`), onSuccess: () => { toast.success('Role deleted'); qc.invalidateQueries({ queryKey: ['roles'] }); }, onError: (e) => toast.error(e) });
  const modules = [...new Set((perms.data?.data ?? []).map((p) => p.module))];
  return (
    <Card title="Roles" bodyClass="p-0" actions={can('roles.manage') && <Button size="sm" onClick={() => setEdit('new')}><Plus className="h-4 w-4" />Custom role</Button>}>
      <QueryState q={roles}>
        <ul className="divide-y divide-slate-100">{roles.data?.data.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{r.name} {r.isSystem ? <Badge>System</Badge> : <Badge className="bg-violet-100 text-violet-800">Custom</Badge>}</div><div className="text-xs text-slate-500">{r.description} · {r.permissions.length} permissions · {r.memberCount} users</div></div>
            {can('roles.manage') && r.key !== 'owner' && <Button size="sm" variant="ghost" onClick={() => setEdit(r)}>Edit</Button>}
            {can('roles.manage') && !r.isSystem && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => del.mutate(r.id)}>Delete</Button>}</li>))}</ul>
      </QueryState>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'New custom role' : `Edit ${name}`} wide footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button disabled={name.length < 2} loading={save.isPending} onClick={() => save.mutate()}>Save role</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Description"><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field></div>
        <div className="mt-4 space-y-4">{modules.map((m) => (
          <div key={m}><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{m}</div><div className="grid gap-1 sm:grid-cols-2">{perms.data!.data.filter((p) => p.module === m).map((p) => <label key={p.code} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={sel.includes(p.code)} onChange={(e) => setSel((s) => (e.target.checked ? [...s, p.code] : s.filter((x) => x !== p.code)))} /><span>{p.description} <code className="text-[11px] text-slate-400">{p.code}</code></span></label>)}</div></div>))}</div>
      </Modal>
    </Card>
  );
}

function AuditLog() {
  const [page, setPage] = useState(1);
  const [entityType, setType] = useState('');
  const [open, setOpen] = useState<Record<string, unknown> | null>(null);
  const q = useQuery({ queryKey: ['audit', page, entityType], queryFn: () => api.get<{ id: string; action: string; entityType: string; entityId: string | null; createdAt: string; actorName: string | null; actorEmail: string | null; before: unknown; after: unknown; metadata: unknown }[]>(`/institution/current/audit?page=${page}${entityType ? `&entityType=${entityType}` : ''}`) });
  return (
    <Card bodyClass="p-0" title="Audit log" actions={<Select className="w-auto" value={entityType} onChange={(v) => { setType(v); setPage(1); }} placeholder="All entities" options={['attendance_record', 'attendance_session', 'attendance_policy', 'correction_request', 'student', 'staff', 'membership', 'role', 'student_leave', 'institution', 'report'].map((x) => ({ value: x, label: titleCase(x) }))} />}>
      <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No audit events" /> : undefined}>
        <ul className="divide-y divide-slate-100">{q.data?.data.map((a) => (
          <li key={a.id}><button className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50" onClick={() => setOpen(a as never)}><div className="min-w-0 flex-1"><div className="text-sm font-medium">{a.action}</div><div className="text-xs text-slate-500">{a.actorName ?? 'System'} · {a.entityType}</div></div><span className="text-xs text-slate-500">{fmtDateTime(a.createdAt)}</span></button></li>))}</ul>
        <Pagination meta={q.data?.meta as never} onPage={setPage} />
      </QueryState>
      <Modal open={!!open} onClose={() => setOpen(null)} title={String(open?.action ?? '')} wide>
        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-slate-50 p-3 text-xs">{JSON.stringify({ before: open?.before, after: open?.after, metadata: open?.metadata }, null, 2)}</pre>
      </Modal>
    </Card>
  );
}

function Account() {
  const { user } = useAuth();
  const toast = useToast();
  const [cur, setCur] = useState(''); const [next, setNext] = useState('');
  const m = useMutation({ mutationFn: () => api.post('/auth/change-password', { currentPassword: cur, newPassword: next }), onSuccess: () => { toast.success('Password changed. Other devices have been signed out.'); setCur(''); setNext(''); }, onError: (e) => toast.error(e) });
  return (
    <Card title="My account" className="max-w-lg">
      <p className="text-sm"><b>{user?.fullName}</b> · {user?.email}</p>
      <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Current password"><input type="password" className="input" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="New password" hint="10+ characters with letters and numbers"><input type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
        <Button disabled={!cur || next.length < 10} loading={m.isPending}>Change password</Button>
      </form>
    </Card>
  );
}
