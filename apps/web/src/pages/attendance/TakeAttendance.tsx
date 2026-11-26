import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarOff, CheckCircle2, CircleDashed, Clock, PlayCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Empty, Field, Modal, PageHeader, QueryState, Select, useToast } from '../../components/ui';
import { fmtDate, fmtTime, todayIso } from '../../lib/format';

interface TodayData {
  date: string; isHoliday: boolean; holiday: { title: string } | null; isWorkingDay: boolean;
  periods: { entryId: string; periodId: string; periodName: string; startTime: string; endTime: string; offeringId: string; subjectName: string; subjectCode: string; subjectKind: string; sectionId: string | null; sectionName: string | null; classLevelName: string | null; roomName: string | null; staffName: string | null; session: { id: string; status: string } | null }[];
  registers: { sectionId: string; sectionName: string; classLevelName: string; session: { id: string; status: string } | null }[];
}

export function useStartSession() {
  const nav = useNavigate();
  const toast = useToast();
  return useMutation({
    mutationFn: (b: Record<string, unknown>) => api.post<{ id: string }>('/attendance/sessions', b),
    onSuccess: (r) => nav(`/attendance/session/${r.data.id}`),
    onError: (e) => toast.error(e),
  });
}

export function TodayPanel({ compact, date, mine }: { compact?: boolean; date?: string; mine?: boolean }) {
  const d = date ?? todayIso();
  const q = useQuery({ queryKey: ['today', d, mine], queryFn: () => api.get<TodayData>(`/attendance/today?date=${d}${mine ? '&mine=true' : ''}`) });
  const start = useStartSession();
  const nav = useNavigate();
  const data = q.data?.data;
  const nowHm = new Date().toTimeString().slice(0, 5);
  const pending = data ? data.periods.filter((p) => p.session?.status !== 'submitted').length + data.registers.filter((r) => r.session?.status !== 'submitted').length : 0;
  return (
    <Card title={compact ? "Today's classes" : `Classes on ${fmtDate(d)}`} actions={data && <Badge className={pending ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}>{pending ? `${pending} pending` : 'All submitted'}</Badge>} bodyClass="p-0" className={compact ? 'mt-5' : ''}>
      <QueryState q={q}>
        {data && (data.isHoliday ? <Empty icon={<CalendarOff className="h-6 w-6" />} title={`Holiday: ${data.holiday?.title}`} hint="No attendance is expected today." /> :
          !data.periods.length && !data.registers.length ? <Empty title="No classes scheduled" hint={data.isWorkingDay ? 'Nothing on your timetable for this day.' : 'This is not a working day.'} /> : (
          <ul className="divide-y divide-slate-100">
            {data.registers.map((r) => (
              <Row key={r.sectionId} title={`Daily register · ${r.classLevelName} ${r.sectionName}`} sub="Whole-day attendance" status={r.session?.status}
                onOpen={() => (r.session ? nav(`/attendance/session/${r.session.id}`) : start.mutate({ kind: 'daily', date: d, sectionId: r.sectionId }))} loading={start.isPending} />
            ))}
            {data.periods.map((p) => (
              <Row key={p.entryId} title={`${p.subjectName}${p.classLevelName ? ` · ${p.classLevelName} ${p.sectionName}` : ''}`} status={p.session?.status} current={d === todayIso() && p.startTime.slice(0, 5) <= nowHm && p.endTime.slice(0, 5) > nowHm}
                sub={`${p.periodName} · ${fmtTime(p.startTime)}–${fmtTime(p.endTime)}${p.roomName ? ` · ${p.roomName}` : ''}${!mine && p.staffName ? ` · ${p.staffName}` : ''}`}
                onOpen={() => (p.session ? nav(`/attendance/session/${p.session.id}`) : start.mutate({ kind: p.subjectKind === 'lab' ? 'lab' : 'subject', date: d, courseOfferingId: p.offeringId, periodId: p.periodId, timetableEntryId: p.entryId }))} loading={start.isPending} />
            ))}
          </ul>
        ))}
      </QueryState>
    </Card>
  );
}

function Row({ title, sub, status, onOpen, loading, current }: { title: string; sub: string; status?: string; onOpen: () => void; loading: boolean; current?: boolean }) {
  return (
    <li className={`flex items-center gap-3 px-4 py-3 ${current ? 'bg-brand-50/60' : ''}`}>
      <div className="shrink-0">{status === 'submitted' ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : status === 'open' ? <Clock className="h-5 w-5 text-amber-500" /> : <CircleDashed className="h-5 w-5 text-slate-300" />}</div>
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-slate-800">{title}{current && <Badge className="ml-2 bg-brand-100 text-brand-700">Now</Badge>}</div><div className="truncate text-xs text-slate-500">{sub}</div></div>
      <Button size="sm" variant={status === 'submitted' ? 'outline' : 'primary'} onClick={onOpen} disabled={loading}>{status === 'submitted' ? 'View' : status === 'open' ? 'Continue' : <><PlayCircle className="h-4 w-4" />Start</>}</Button>
    </li>
  );
}

export default function TakeAttendance() {
  const { can } = useAuth();
  const [date, setDate] = useState(todayIso());
  const [adhoc, setAdhoc] = useState(false);
  const anyMode = can('attendance.take.any');
  const [mine, setMine] = useState(!anyMode ? false : true);
  return (
    <div>
      <PageHeader title="Take attendance" subtitle="Pick a scheduled class. Mark everyone present in one tap, then change exceptions."
        actions={<>
          <input type="date" className="input w-auto" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          {anyMode && <Select className="w-auto" value={mine ? 'mine' : 'all'} onChange={(v) => setMine(v === 'mine')} options={[{ value: 'mine', label: 'My classes' }, { value: 'all', label: 'All classes' }]} />}
          <Button variant="outline" onClick={() => setAdhoc(true)}>Unscheduled session</Button>
        </>} />
      <TodayPanel date={date} mine={anyMode ? mine : undefined} />
      <AdhocModal open={adhoc} onClose={() => setAdhoc(false)} date={date} />
    </div>
  );
}

function AdhocModal({ open, onClose, date }: { open: boolean; onClose: () => void; date: string }) {
  const { context } = useAuth();
  const offerings = useQuery({ queryKey: ['offerings', 'mine', context?.staffId], queryFn: () => api.get<{ id: string; subjectId: string; sectionId: string | null; label: string | null }[]>(`/academic/offerings?pageSize=500${context?.staffId ? `&staffId=${context.staffId}` : ''}`), enabled: open });
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: () => api.get<{ id: string; name: string }[]>('/academic/subjects?pageSize=500'), enabled: open });
  const sections = useQuery({ queryKey: ['sections'], queryFn: () => api.get<{ id: string; name: string; classLevelId: string }[]>('/academic/sections?pageSize=500'), enabled: open });
  const levels = useQuery({ queryKey: ['class-levels'], queryFn: () => api.get<{ id: string; name: string }[]>('/academic/class-levels?pageSize=500'), enabled: open });
  const [kind, setKind] = useState('subject');
  const [target, setTarget] = useState('');
  const start = useStartSession();
  const secLabel = (id: string | null) => { const s = sections.data?.data.find((x) => x.id === id); return s ? `${levels.data?.data.find((l) => l.id === s.classLevelId)?.name ?? ''} ${s.name}` : ''; };
  const offerOpts = (offerings.data?.data ?? []).map((o) => ({ value: o.id, label: `${subjects.data?.data.find((s) => s.id === o.subjectId)?.name ?? 'Subject'} · ${secLabel(o.sectionId) || o.label || 'Elective group'}` }));
  const sectionOpts = (sections.data?.data ?? []).map((s) => ({ value: s.id, label: secLabel(s.id) }));
  const sectionKinds = ['daily', 'assembly', 'event', 'exam'];
  return (
    <Modal open={open} onClose={onClose} title="Start an unscheduled session" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!target} loading={start.isPending} onClick={() => start.mutate({ kind, date, ...(sectionKinds.includes(kind) ? { sectionId: target } : { courseOfferingId: target }) })}>Start</Button></>}>
      <div className="space-y-4">
        <Field label="Session type"><Select value={kind} onChange={(v) => { setKind(v); setTarget(''); }} options={['subject', 'lab', 'practical', 'daily', 'assembly', 'event', 'exam'].map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) }))} /></Field>
        <Field label={sectionKinds.includes(kind) ? 'Class / section' : 'Subject class'}><Select value={target} onChange={setTarget} placeholder="Select…" options={sectionKinds.includes(kind) ? sectionOpts : offerOpts} /></Field>
        <p className="text-xs text-slate-500">You can only start sessions for classes assigned to you unless you have institution-wide attendance permission.</p>
      </div>
    </Modal>
  );
}
