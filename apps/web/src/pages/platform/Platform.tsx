import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Empty, Field, Modal, PageHeader, Pagination, QueryState, Select, Stat, useToast } from '../../components/ui';
import { fmtDate, fmtDateTime, titleCase } from '../../lib/format';

interface Inst { id: string; name: string; type: string; status: string; isDemo: boolean; createdAt: string; studentCount: number; userCount: number; plan: string | null; subscriptionStatus: string | null }

export default function Platform() {
  const { user } = useAuth();
  const [page, setPage] = useState(1); const [status, setStatus] = useState(''); const [search, setSearch] = useState('');
  const [act, setAct] = useState<{ kind: 'status' | 'plan'; i: Inst } | null>(null);
  const stats = useQuery({ queryKey: ['platform-stats'], queryFn: () => api.get<{ totalInstitutions: number; institutions: Record<string, number>; totalStudents: number; totalUsers: number; ai30d: { runs: number; tokens: number }; health: { api: string; dbLatencyMs: number; databaseBytes: number; uptimeSeconds: number }; subscriptions: { status: string; plan: string; n: number }[] }>('/platform/stats'), enabled: user?.platformRole === 'super_admin' });
  const q = useQuery({ queryKey: ['platform-inst', page, status, search], queryFn: () => api.get<Inst[]>(`/platform/institutions${qs({ page, status, search })}`), enabled: user?.platformRole === 'super_admin' });
  const audit = useQuery({ queryKey: ['platform-audit'], queryFn: () => api.get<{ id: string; action: string; institutionId: string; createdAt: string; actor: string | null; metadata: { reason?: string } | null }[]>('/platform/audit?pageSize=10'), enabled: user?.platformRole === 'super_admin' });
  if (user?.platformRole !== 'super_admin') return <Empty title="Platform administrators only" />;
  const s = stats.data?.data;
  return (
    <div>
      <PageHeader title="Platform administration" subtitle="Institution-level metadata and aggregate counts only. Student records are not accessible from this console." />
      {s && <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Institutions" value={s.totalInstitutions} hint={`${s.institutions.active ?? 0} active · ${s.institutions.suspended ?? 0} suspended`} />
        <Stat label="Students" value={s.totalStudents.toLocaleString('en-IN')} /><Stat label="Users" value={s.totalUsers.toLocaleString('en-IN')} />
        <Stat label="AI usage (30d)" value={s.ai30d.runs} hint={`${s.ai30d.tokens.toLocaleString('en-IN')} tokens`} />
        <Stat label="System health" value={s.health.api === 'ok' ? 'Healthy' : 'Degraded'} tone={s.health.api === 'ok' ? 'good' : 'bad'} hint={`DB ${s.health.dbLatencyMs} ms · ${(s.health.databaseBytes / 1e6).toFixed(0)} MB · up ${Math.round(s.health.uptimeSeconds / 3600)} h`} />
      </div>}
      <Card bodyClass="p-0" title="Institutions">
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3"><input className="input max-w-xs" placeholder="Search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /><Select className="w-auto" value={status} onChange={(v) => { setStatus(v); setPage(1); }} placeholder="Any status" options={['active', 'suspended', 'pending'].map((x) => ({ value: x, label: x }))} /></div>
        <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No institutions" /> : undefined}>
          <div className="overflow-x-auto"><table className="w-full min-w-[820px]"><thead className="bg-slate-50"><tr><th className="th">Institution</th><th className="th">Type</th><th className="th text-right">Students</th><th className="th text-right">Users</th><th className="th">Plan</th><th className="th">Status</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{q.data?.data.map((i) => (
              <tr key={i.id}><td className="td"><div className="font-medium">{i.name} {i.isDemo && <Badge className="bg-violet-100 text-violet-800">Demo</Badge>}</div><div className="text-xs text-slate-500">Registered {fmtDate(i.createdAt)}</div></td><td className="td">{titleCase(i.type)}</td><td className="td text-right tabular-nums">{i.studentCount}</td><td className="td text-right tabular-nums">{i.userCount}</td>
                <td className="td">{i.plan ?? '—'} <span className="text-xs text-slate-500">{i.subscriptionStatus}</span></td><td className="td"><Badge className={i.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}>{i.status}</Badge></td>
                <td className="td whitespace-nowrap text-right"><Button size="sm" variant="ghost" onClick={() => setAct({ kind: 'plan', i })}>Plan</Button><Button size="sm" variant="ghost" onClick={() => setAct({ kind: 'status', i })}>{i.status === 'active' ? 'Suspend' : 'Activate'}</Button></td></tr>))}</tbody></table></div>
          <Pagination meta={q.data?.meta as never} onPage={setPage} />
        </QueryState>
      </Card>
      <Card className="mt-5" title="Recent platform events" bodyClass="p-0"><QueryState q={audit}><ul className="divide-y divide-slate-100 text-sm">{audit.data?.data.map((a) => <li key={a.id} className="px-4 py-2"><b>{a.action}</b> <span className="text-slate-500">· {a.actor ?? 'system'} · {fmtDateTime(a.createdAt)}{a.metadata?.reason ? ` · ${a.metadata.reason}` : ''}</span></li>)}</ul></QueryState></Card>
      {act && <ActionModal act={act} onClose={() => setAct(null)} />}
    </div>
  );
}

function ActionModal({ act, onClose }: { act: { kind: 'status' | 'plan'; i: Inst }; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [reason, setReason] = useState(''); const [plan, setPlan] = useState(act.i.plan ?? 'professional'); const [subStatus, setSubStatus] = useState(act.i.subscriptionStatus ?? 'active');
  const m = useMutation({
    mutationFn: () => act.kind === 'status' ? api.patch(`/platform/institutions/${act.i.id}/status`, { status: act.i.status === 'active' ? 'suspended' : 'active', reason }) : api.put(`/platform/institutions/${act.i.id}/subscription`, { planCode: plan, status: subStatus }),
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['platform-inst'] }); onClose(); }, onError: (e) => toast.error(e),
  });
  return (
    <Modal open onClose={onClose} title={act.kind === 'status' ? `${act.i.status === 'active' ? 'Suspend' : 'Activate'} ${act.i.name}` : `Subscription · ${act.i.name}`} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant={act.kind === 'status' && act.i.status === 'active' ? 'danger' : 'primary'} disabled={act.kind === 'status' && reason.length < 3} loading={m.isPending} onClick={() => m.mutate()}>Confirm</Button></>}>
      {act.kind === 'status' ? <Field label="Reason (recorded in the audit log)"><textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field> : (
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Plan"><Select value={plan} onChange={setPlan} options={['starter', 'professional', 'enterprise'].map((x) => ({ value: x, label: titleCase(x) }))} /></Field><Field label="Status"><Select value={subStatus} onChange={setSubStatus} options={['trial', 'active', 'past_due', 'expired', 'cancelled'].map((x) => ({ value: x, label: titleCase(x) }))} /></Field></div>
      )}
      {act.kind === 'status' && act.i.status === 'active' && <p className="mt-3 text-sm text-slate-600">All users of this institution lose access immediately until it is reactivated. No data is deleted.</p>}
    </Modal>
  );
}
