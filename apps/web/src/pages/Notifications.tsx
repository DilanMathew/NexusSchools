import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { api, qs } from '../lib/api';
import { Button, Card, Empty, PageHeader, Pagination, QueryState, Tabs } from '../components/ui';
import { fmtDateTime } from '../lib/format';

interface N { id: string; title: string; body: string; eventKey: string; readAt: string | null; createdAt: string }
const EVENTS = [{ key: 'attendance.absent', label: 'Marked absent' }, { key: 'attendance.late', label: 'Marked late' }, { key: 'attendance.correction', label: 'Correction decisions' }, { key: 'leave.approved', label: 'Leave approved' }, { key: 'leave.rejected', label: 'Leave rejected' }, { key: 'leave.submitted', label: 'New leave requests (teachers)' }];

export default function Notifications() {
  const [tab, setTab] = useState<'inbox' | 'prefs'>('inbox');
  return (
    <div>
      <PageHeader title="Notifications" />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'inbox', label: 'Inbox' }, { key: 'prefs', label: 'Preferences' }]} />
      {tab === 'inbox' ? <Inbox /> : <Prefs />}
    </div>
  );
}

function Inbox() {
  const [page, setPage] = useState(1);
  const [unread, setUnread] = useState(false);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications', page, unread], queryFn: () => api.get<N[]>(`/notifications${qs({ page, unread: unread ? 'true' : undefined })}`) });
  const mark = useMutation({ mutationFn: (ids?: string[]) => api.post('/notifications/read', ids ? { ids } : {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  return (
    <Card bodyClass="p-0" title={<label className="flex items-center gap-2 text-sm font-normal"><input type="checkbox" checked={unread} onChange={(e) => { setUnread(e.target.checked); setPage(1); }} />Unread only</label>} actions={<Button size="sm" variant="outline" onClick={() => mark.mutate(undefined)}>Mark all read</Button>}>
      <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty icon={<Bell className="h-6 w-6" />} title="You're all caught up" /> : undefined}>
        <ul className="divide-y divide-slate-100">{q.data?.data.map((n) => (
          <li key={n.id} className={`flex gap-3 px-4 py-3 ${!n.readAt ? 'bg-brand-50/40' : ''}`}>
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-brand-600'}`} />
            <div className="min-w-0 flex-1"><div className="text-sm font-medium">{n.title}</div><div className="text-sm text-slate-600">{n.body}</div><div className="mt-0.5 text-xs text-slate-400">{fmtDateTime(n.createdAt)}</div></div>
            {!n.readAt && <Button size="sm" variant="ghost" onClick={() => mark.mutate([n.id])}>Mark read</Button>}
          </li>))}</ul>
        <Pagination meta={q.data?.meta as never} onPage={setPage} />
      </QueryState>
    </Card>
  );
}

function Prefs() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notif-prefs'], queryFn: () => api.get<{ eventKey: string; channel: string; enabled: boolean }[]>('/notifications/preferences') });
  const save = useMutation({ mutationFn: (p: { eventKey: string; channel: string; enabled: boolean }) => api.put('/notifications/preferences', { prefs: [p] }), onSuccess: () => qc.invalidateQueries({ queryKey: ['notif-prefs'] }) });
  const enabled = (k: string, ch: string) => q.data?.data.find((p) => p.eventKey === k && p.channel === ch)?.enabled ?? true;
  const channels = ['in_app', 'email', 'sms', 'whatsapp'];
  return (
    <Card bodyClass="p-0">
      <QueryState q={q}>
        <div className="overflow-x-auto"><table className="w-full min-w-[520px]"><thead className="bg-slate-50"><tr><th className="th">Event</th>{channels.map((c) => <th key={c} className="th text-center">{c === 'in_app' ? 'In-app' : c === 'sms' ? 'SMS' : c[0].toUpperCase() + c.slice(1)}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">{EVENTS.map((e) => <tr key={e.key}><td className="td">{e.label}</td>{channels.map((c) => <td key={c} className="td text-center"><input type="checkbox" checked={enabled(e.key, c)} onChange={(x) => save.mutate({ eventKey: e.key, channel: c, enabled: x.target.checked })} aria-label={`${e.label} via ${c}`} /></td>)}</tr>)}</tbody></table></div>
        <p className="px-4 py-3 text-xs text-slate-500">Email, SMS and WhatsApp are delivered only when your institution has configured a provider. Some notices may be required by your institution regardless of these settings.</p>
      </QueryState>
    </Card>
  );
}
