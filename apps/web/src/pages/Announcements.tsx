import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, Empty, PageHeader, QueryState, useToast } from '../components/ui';
import { FormModal } from '../components/FormModal';
import { fmtDateTime } from '../lib/format';

interface A { id: string; title: string; body: string; audience: string[]; publishAt: string; expiresAt: string | null; author: string | null; read: boolean }

export default function Announcements() {
  const { can } = useAuth();
  const manage = can('announcements.manage');
  const [create, setCreate] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['announcements'], queryFn: () => api.get<A[]>('/announcements') });
  const read = useMutation({ mutationFn: (id: string) => api.post(`/announcements/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ['announcements'] }) });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/announcements/${id}`), onSuccess: () => { toast.success('Deleted'); qc.invalidateQueries({ queryKey: ['announcements'] }); } });
  const now = new Date();
  return (
    <div>
      <PageHeader title="Announcements" actions={manage && <Button onClick={() => setCreate(true)}><Plus className="h-4 w-4" />New announcement</Button>} />
      <QueryState q={q} empty={q.data?.data.length === 0 ? <Card><Empty icon={<Megaphone className="h-6 w-6" />} title="No announcements" /></Card> : undefined}>
        <div className="space-y-3">{q.data?.data.map((a) => {
          const scheduled = new Date(a.publishAt) > now; const expired = a.expiresAt && new Date(a.expiresAt) < now;
          return (
            <Card key={a.id} className={!a.read ? 'border-brand-200' : ''}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><h3 className="font-semibold text-slate-900">{a.title} {!a.read && <Badge className="ml-1 bg-brand-100 text-brand-700">New</Badge>}{scheduled && <Badge className="ml-1 bg-amber-100 text-amber-800">Scheduled</Badge>}{expired && <Badge className="ml-1">Expired</Badge>}</h3>
                  <p className="mt-1 text-xs text-slate-500">{a.author ?? 'Institution'} · {fmtDateTime(a.publishAt)}{manage && ` · to ${a.audience.join(', ')}`}</p></div>
                <div className="flex shrink-0 gap-1">{!a.read && <Button size="sm" variant="ghost" onClick={() => read.mutate(a.id)}>Mark read</Button>}{manage && <button className="rounded p-1.5 text-slate-400 hover:text-red-600" onClick={() => del.mutate(a.id)} aria-label="Delete"><Trash2 className="h-4 w-4" /></button>}</div>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{a.body}</p>
            </Card>
          );
        })}</div>
      </QueryState>
      <FormModal open={create} onClose={() => setCreate(false)} title="New announcement" submitLabel="Publish" wide initial={{ audience: ['students', 'guardians', 'staff'] }}
        fields={[{ name: 'title', label: 'Title', required: true }, { name: 'body', label: 'Message', type: 'textarea', required: true }, { name: 'audience', label: 'Audience', type: 'multiselect', required: true, options: [{ value: 'students', label: 'Students' }, { value: 'guardians', label: 'Parents / guardians' }, { value: 'staff', label: 'Staff' }] }, { name: 'publishAt', label: 'Publish at (optional, to schedule)', type: 'datetime-local', half: true }, { name: 'expiresAt', label: 'Expires at (optional)', type: 'datetime-local', half: true }]}
        onSubmit={async (v) => { await api.post('/announcements', { ...v, publishAt: v.publishAt ? new Date(v.publishAt as string).toISOString() : undefined, expiresAt: v.expiresAt ? new Date(v.expiresAt as string).toISOString() : undefined }); toast.success('Announcement published'); qc.invalidateQueries({ queryKey: ['announcements'] }); }} />
    </div>
  );
}
