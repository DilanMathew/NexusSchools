import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Button, Card, Empty, Modal, Pagination, QueryState, useToast } from '../../components/ui';
import { FormModal } from '../../components/FormModal';
import { fmtDateTime, titleCase } from '../../lib/format';

interface Device { id: string; name: string; kind: string; location: string | null; isActive: boolean; lastSeenAt: string | null; lastError: string | null; health: string; events24h: number }
const healthCls: Record<string, string> = { online: 'bg-emerald-100 text-emerald-800', stale: 'bg-amber-100 text-amber-800', offline: 'bg-red-100 text-red-800', never_seen: '', disabled: '' };

export function DevicesSettings() {
  const qc = useQueryClient(); const toast = useToast();
  const [add, setAdd] = useState(false); const [card, setCard] = useState(false);
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [page, setPage] = useState(1); const [search, setSearch] = useState('');
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api.get<Device[]>('/devices') });
  const cards = useQuery({ queryKey: ['cards', page, search], queryFn: () => api.get<{ id: string; cardUid: string; status: string; studentName: string; admissionNumber: string; issuedAt: string }[]>(`/devices/cards?page=${page}&search=${encodeURIComponent(search)}`) });
  const students = useQuery({ queryKey: ['students', 'card-pick'], queryFn: () => api.get<{ id: string; firstName: string; lastName: string; admissionNumber: string }[]>('/students?pageSize=200'), enabled: card });
  const toggle = useMutation({ mutationFn: (d: Device) => api.patch(`/devices/${d.id}`, { isActive: !d.isActive }), onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }) });
  const rotate = useMutation({ mutationFn: (id: string) => api.post<{ deviceKey: string }>(`/devices/${id}/rotate-key`), onSuccess: (r) => setShownKey(r.data.deviceKey) });
  const cardStatus = useMutation({ mutationFn: (v: { id: string; status: string }) => api.post(`/devices/cards/${v.id}/status`, { status: v.status }), onSuccess: () => { toast.success('Card updated'); qc.invalidateQueries({ queryKey: ['cards'] }); } });
  return (
    <div className="space-y-5">
      <Card title="Readers & gates" actions={<Button size="sm" onClick={() => setAdd(true)}><Plus className="h-4 w-4" />Register device</Button>} bodyClass="p-0">
        <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">Devices post events to <code>/api/device/events</code> with their key in the <code>X-Device-Key</code> header (generic JSON adapter). Events are de-duplicated by event id, so readers can resend buffered events after being offline.</p>
        <QueryState q={devices} empty={devices.data?.data.length === 0 ? <Empty title="No devices registered" /> : undefined}>
          <ul className="divide-y divide-slate-100">{devices.data?.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{d.name} <span className="font-normal text-slate-500">· {titleCase(d.kind)}{d.location && ` · ${d.location}`}</span></div><div className="text-xs text-slate-500">Last seen {fmtDateTime(d.lastSeenAt)} · {d.events24h} events in 24 h{d.lastError && <span className="text-red-600"> · {d.lastError}</span>}</div></div>
              <Badge className={healthCls[d.health]}>{titleCase(d.health)}</Badge><Button size="sm" variant="ghost" onClick={() => rotate.mutate(d.id)}>New key</Button><Button size="sm" variant="ghost" onClick={() => toggle.mutate(d)}>{d.isActive ? 'Disable' : 'Enable'}</Button></li>))}</ul>
        </QueryState>
      </Card>
      <Card title="RFID / NFC cards" actions={<Button size="sm" onClick={() => setCard(true)}><Plus className="h-4 w-4" />Assign card</Button>} bodyClass="p-0">
        <div className="border-b border-slate-100 p-3"><input className="input max-w-xs" placeholder="Search card or student" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
        <QueryState q={cards} empty={cards.data?.data.length === 0 ? <Empty title="No cards issued" /> : undefined}>
          <ul className="divide-y divide-slate-100">{cards.data?.data.map((c) => <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm"><code className="rounded bg-slate-100 px-2 py-0.5 text-xs">{c.cardUid}</code><span className="flex-1">{c.studentName} <span className="text-slate-500">· {c.admissionNumber}</span></span><Badge className={c.status === 'active' ? 'bg-emerald-100 text-emerald-800' : ''}>{c.status}</Badge>{c.status === 'active' && <><Button size="sm" variant="ghost" onClick={() => cardStatus.mutate({ id: c.id, status: 'lost' })}>Mark lost</Button><Button size="sm" variant="ghost" onClick={() => cardStatus.mutate({ id: c.id, status: 'deactivated' })}>Deactivate</Button></>}</li>)}</ul>
          <Pagination meta={cards.data?.meta as never} onPage={setPage} />
        </QueryState>
      </Card>
      <FormModal open={add} onClose={() => setAdd(false)} title="Register a device" submitLabel="Register"
        fields={[{ name: 'name', label: 'Name', required: true, placeholder: 'Main gate reader' }, { name: 'kind', label: 'Type', type: 'select', required: true, options: [{ value: 'rfid_reader', label: 'RFID reader' }, { value: 'nfc_reader', label: 'NFC reader' }, { value: 'qr_gate', label: 'QR gate scanner' }, { value: 'other', label: 'Other' }] }, { name: 'location', label: 'Location' }]}
        onSubmit={async (v) => { const r = await api.post<{ deviceKey: string }>('/devices', v); setShownKey(r.data.deviceKey); qc.invalidateQueries({ queryKey: ['devices'] }); }} />
      <FormModal open={card} onClose={() => setCard(false)} title="Assign a card" submitLabel="Assign"
        fields={[{ name: 'studentId', label: 'Student', type: 'select', required: true, options: (students.data?.data ?? []).map((s) => ({ value: s.id, label: `${s.firstName} ${s.lastName} (${s.admissionNumber})` })), hint: 'Assigning replaces any card the student already has.' }, { name: 'cardUid', label: 'Card UID', required: true, hint: 'As printed on the card or read by the reader.' }]}
        onSubmit={async (v) => { await api.post('/devices/cards', v); toast.success('Card assigned'); qc.invalidateQueries({ queryKey: ['cards'] }); }} />
      <Modal open={!!shownKey} onClose={() => setShownKey(null)} title="Device key" footer={<Button onClick={() => setShownKey(null)}>I have stored it</Button>}>
        <p className="text-sm text-slate-600">Configure this key on the device now. It is shown only once; if lost, generate a new key.</p>
        <div className="mt-3 flex items-center gap-2"><code className="flex-1 break-all rounded-lg bg-slate-100 p-3 text-xs">{shownKey}</code><Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(shownKey ?? '').then(() => toast.success('Copied'))} aria-label="Copy"><Copy className="h-4 w-4" /></Button></div>
      </Modal>
    </div>
  );
}
