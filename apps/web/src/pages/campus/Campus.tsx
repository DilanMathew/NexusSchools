import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DoorOpen, LogIn, LogOut } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Empty, Field, PageHeader, QueryState, Stat, Tabs, useToast } from '../../components/ui';
import { FormModal } from '../../components/FormModal';
import { fmtDateTime, todayIso } from '../../lib/format';

interface Summary { date: string; onCampusNow: number; checkedIn: number; late: Row[]; earlyDepartures: Row[]; students: Row[] }
interface Row { studentId: string; name: string; admissionNumber: string; classLabel: string; firstIn: string | null; lastOut: string | null; late: boolean; earlyDeparture: boolean; onCampus: boolean }
const time = (d: string | null, tz?: string) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: tz }) : '—');

export default function Campus() {
  const { can, context } = useAuth();
  const [tab, setTab] = useState<'today' | 'events' | 'visitors'>('today');
  const [date, setDate] = useState(todayIso());
  const [lateAfter, setLate] = useState('09:00');
  return (
    <div>
      <PageHeader title="Campus entry & exit" subtitle={`Gate presence from card readers and manual entries, shown in ${context?.timezone ?? 'local'} time. This is separate from class attendance and never marks anyone present for a class.`}
        actions={<><input type="date" className="input w-auto" value={date} onChange={(e) => setDate(e.target.value)} /><Field label=""><input type="time" className="input w-auto" value={lateAfter} onChange={(e) => setLate(e.target.value)} title="Late after" /></Field></>} />
      {can('attendance.entry') && <ManualEntry />}
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'today', label: 'Daily summary' }, { key: 'events', label: 'Gate events' }, { key: 'visitors', label: 'Visitors' }]} />
      {tab === 'today' && <SummaryView date={date} lateAfter={lateAfter} />}
      {tab === 'events' && <Events date={date} />}
      {tab === 'visitors' && <Visitors />}
    </div>
  );
}

function ManualEntry() {
  const [ident, setIdent] = useState('');
  const toast = useToast(); const qc = useQueryClient();
  const m = useMutation({ mutationFn: (direction: 'in' | 'out') => api.post<{ studentName: string }>('/devices/campus/events', { identifier: ident, direction }), onSuccess: (r, d) => { toast.success(`${r.data.studentName} checked ${d}`); setIdent(''); qc.invalidateQueries({ queryKey: ['campus'] }); }, onError: (e) => toast.error(e) });
  return (
    <Card className="mb-5" title={<span className="flex items-center gap-2"><DoorOpen className="h-4 w-4" />Manual gate entry</span>}>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); m.mutate('in'); }}>
        <input className="input max-w-sm" placeholder="Admission number or scanned ID-card code" value={ident} onChange={(e) => setIdent(e.target.value)} autoFocus />
        <Button disabled={!ident} loading={m.isPending}><LogIn className="h-4 w-4" />Check in</Button>
        <Button type="button" variant="outline" disabled={!ident} onClick={() => m.mutate('out')}><LogOut className="h-4 w-4" />Check out</Button>
      </form>
    </Card>
  );
}

function SummaryView({ date, lateAfter }: { date: string; lateAfter: string }) {
  const tz = useAuth().context?.timezone;
  const q = useQuery({ queryKey: ['campus', 'summary', date, lateAfter], queryFn: () => api.get<Summary>(`/devices/campus/summary${qs({ date, lateAfter })}`) });
  const d = q.data?.data;
  return (
    <QueryState q={q}>
      {d && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="Checked in" value={d.checkedIn} /><Stat label="On campus now" value={d.onCampusNow} tone="brand" /><Stat label="Late arrivals" value={d.late.length} tone={d.late.length ? 'warn' : 'default'} hint={`after ${lateAfter}`} /><Stat label="Early departures" value={d.earlyDepartures.length} /></div>
          <Card bodyClass="p-0" title="Students">
            {!d.students.length ? <Empty title="No gate events for this day" hint="Events appear when registered readers send them, or when an operator records a manual entry." /> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[600px]"><thead className="bg-slate-50"><tr><th className="th">Student</th><th className="th">Class</th><th className="th">First in</th><th className="th">Last out</th><th className="th" /></tr></thead>
                <tbody className="divide-y divide-slate-100">{d.students.map((r) => <tr key={r.studentId}><td className="td font-medium">{r.name}<div className="text-xs text-slate-500">{r.admissionNumber}</div></td><td className="td">{r.classLabel}</td><td className="td tabular-nums">{time(r.firstIn, tz)}</td><td className="td tabular-nums">{time(r.lastOut, tz)}</td><td className="td">{r.late && <Badge className="bg-amber-100 text-amber-800">Late</Badge>} {r.earlyDeparture && <Badge>Left early</Badge>} {r.onCampus && <Badge className="bg-emerald-100 text-emerald-800">On campus</Badge>}</td></tr>)}</tbody></table></div>
            )}
          </Card>
        </div>
      )}
    </QueryState>
  );
}

function Events({ date }: { date: string }) {
  const q = useQuery({ queryKey: ['campus', 'events', date], queryFn: () => api.get<{ id: string; direction: string; source: string; occurredAt: string; deviceName: string | null; studentName: string | null; admissionNumber: string | null; unresolvedIdentifier: string | null }[]>(`/devices/campus/events${qs({ date, pageSize: 200 })}`) });
  return (
    <Card bodyClass="p-0"><QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No gate events" /> : undefined}>
      <ul className="divide-y divide-slate-100">{q.data?.data.map((e) => <li key={e.id} className="flex items-center gap-3 px-4 py-2 text-sm"><Badge className={e.direction === 'in' ? 'bg-emerald-100 text-emerald-800' : ''}>{e.direction}</Badge><span className="flex-1">{e.studentName ?? <span className="text-amber-700">Unknown card {e.unresolvedIdentifier}</span>} <span className="text-slate-500">{e.admissionNumber}</span></span><span className="text-xs text-slate-500">{e.deviceName ?? e.source} · {fmtDateTime(e.occurredAt)}</span></li>)}</ul>
    </QueryState></Card>
  );
}

function Visitors() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['campus', 'visitors'], queryFn: () => api.get<{ id: string; name: string; purpose: string; phone: string | null; checkInAt: string; checkOutAt: string | null }[]>('/devices/visitors') });
  const out = useMutation({ mutationFn: (id: string) => api.post(`/devices/visitors/${id}/checkout`), onSuccess: () => qc.invalidateQueries({ queryKey: ['campus', 'visitors'] }) });
  return (
    <Card bodyClass="p-0" title="Visitor log" actions={can('attendance.entry') && <Button size="sm" onClick={() => setOpen(true)}>Log visitor</Button>}>
      <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No visitors logged" /> : undefined}>
        <ul className="divide-y divide-slate-100">{q.data?.data.map((v) => <li key={v.id} className="flex items-center gap-3 px-4 py-2.5 text-sm"><div className="flex-1"><div className="font-medium">{v.name}</div><div className="text-xs text-slate-500">{v.purpose} · in {fmtDateTime(v.checkInAt)}{v.checkOutAt && ` · out ${fmtDateTime(v.checkOutAt)}`}</div></div>{!v.checkOutAt && can('attendance.entry') && <Button size="sm" variant="outline" onClick={() => out.mutate(v.id)}>Check out</Button>}</li>)}</ul>
      </QueryState>
      <FormModal open={open} onClose={() => setOpen(false)} title="Log a visitor" fields={[{ name: 'name', label: 'Name', required: true }, { name: 'purpose', label: 'Purpose of visit', required: true }, { name: 'phone', label: 'Phone' }]}
        onSubmit={async (v) => { await api.post('/devices/visitors', v); toast.success('Visitor checked in'); qc.invalidateQueries({ queryKey: ['campus', 'visitors'] }); }} />
    </Card>
  );
}
