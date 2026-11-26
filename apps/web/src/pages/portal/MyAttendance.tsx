import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ClipboardCheck, QrCode } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { BAND_META, STATUS_META, type AttendanceStatus } from '../../lib/types';
import { Badge, Button, Card, Empty, Field, Modal, PageHeader, Pagination, PctBar, QueryState, Select, Stat, useToast } from '../../components/ui';
import { fmtDate, fmtPct, fmtTime } from '../../lib/format';

export interface PortalStudent { id: string; name: string; admissionNumber: string; section: string | null; classLevel: string | null; rollNumber: string | null; relation: 'self' | 'child' }
interface Detail { attended: number; conducted: number; percentage: number | null; band: string; requiredPercentage: number; sessionsNeeded: number | null; maxMissable: number; counts: Record<string, number>; excluded: number }
export interface Summary {
  policy: { eligibilityThreshold: number; warningThreshold: number; calculationUnit: string; lateWeight: number; approvedLeaveHandling: string; onDutyCountsAsPresent: boolean };
  overall: Detail; categories: Record<string, Detail>;
  bySubject: (Detail & { subjectId: string; name: string; code: string; kind: string })[];
  monthly: { month: string; percentage: number | null; conducted: number }[];
  consecutiveAbsence: { current: number; longest: number }; lateCount: number; disclaimer: string;
}

export function useMyStudents() {
  return useQuery({ queryKey: ['me', 'students'], queryFn: () => api.get<PortalStudent[]>('/me/students') });
}

/** Cards for the dashboard: one per linked child (or self). */
export function ChildrenOverview() {
  const q = useMyStudents();
  return (
    <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No student linked to your account" hint="Ask your institution to link your account to your child's record." /> : undefined}>
      <div className="grid gap-4 md:grid-cols-2">
        {q.data?.data.map((s) => <StudentCard key={s.id} s={s} />)}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link to="/my-attendance"><Button variant="outline"><ClipboardCheck className="h-4 w-4" />Full attendance</Button></Link>
        <Link to="/leave"><Button variant="outline"><CalendarDays className="h-4 w-4" />Apply for leave</Button></Link>
      </div>
    </QueryState>
  );
}

function StudentCard({ s }: { s: PortalStudent }) {
  const q = useQuery({ queryKey: ['summary', s.id], queryFn: () => api.get<Summary>(`/attendance/students/${s.id}/summary`) });
  const o = q.data?.data.overall;
  return (
    <Card title={<span>{s.name} <span className="font-normal text-slate-500">· {s.classLevel} {s.section}</span></span>} actions={o && <Badge className={BAND_META[o.band].cls}>{BAND_META[o.band].label}</Badge>}>
      <QueryState q={q} rows={2}>
        {o && (
          <div>
            <div className="flex items-end justify-between"><div className="text-3xl font-semibold tabular-nums text-brand-700">{fmtPct(o.percentage)}</div><div className="text-right text-xs text-slate-500">{o.attended} of {o.conducted} counted<br />required {o.requiredPercentage}%</div></div>
            <div className="mt-2"><PctBar value={o.percentage} threshold={o.requiredPercentage} /></div>
            <p className="mt-3 text-sm text-slate-600">{o.band === 'shortage' ? (o.sessionsNeeded === null ? 'The threshold can no longer be reached this term.' : `Needs ${o.sessionsNeeded} consecutive attended sessions to reach ${o.requiredPercentage}%.`) : `Can miss up to ${o.maxMissable} more session${o.maxMissable === 1 ? '' : 's'} and stay at or above ${o.requiredPercentage}%.`}</p>
            {q.data!.data.consecutiveAbsence.current >= 2 && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">Absent {q.data!.data.consecutiveAbsence.current} days in a row.</p>}
          </div>
        )}
      </QueryState>
    </Card>
  );
}

export default function MyAttendance() {
  const { can } = useAuth();
  const kids = useMyStudents();
  const [sp, setSp] = useSearchParams();
  const list = kids.data?.data ?? [];
  const sid = sp.get('student') ?? list[0]?.id;
  const student = list.find((k) => k.id === sid);
  return (
    <div>
      <PageHeader title={student?.relation === 'child' ? `${student.name.split(' ')[0]}'s attendance` : 'My attendance'} subtitle={student ? `${student.classLevel ?? ''} ${student.section ?? ''} · ${student.admissionNumber}` : undefined}
        actions={<>
          {list.length > 1 && <Select className="w-auto" value={sid ?? ''} onChange={(v) => setSp({ student: v })} options={list.map((k) => ({ value: k.id, label: k.name }))} />}
          {can('attendance.self.read') && student?.relation === 'self' && <Link to="/scan"><Button variant="outline"><QrCode className="h-4 w-4" />Scan class QR</Button></Link>}
          <Link to="/leave"><Button variant="outline"><CalendarDays className="h-4 w-4" />Apply for leave</Button></Link>
        </>} />
      <QueryState q={kids} empty={!list.length ? <Empty title="No student linked to your account" /> : undefined}>
        {sid && <StudentAttendance studentId={sid} canRequest={can('attendance.correction.request', 'attendance.child.read')} />}
      </QueryState>
    </div>
  );
}

/** Reusable attendance view for one student (portal and staff student profile). */
export function StudentAttendance({ studentId, canRequest }: { studentId: string; canRequest?: boolean }) {
  const q = useQuery({ queryKey: ['summary', studentId], queryFn: () => api.get<Summary>(`/attendance/students/${studentId}/summary`) });
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const recs = useQuery({ queryKey: ['records', studentId, page, status], queryFn: () => api.get<{ id: string; status: AttendanceStatus; date: string; kind: string; subjectName: string | null; periodName: string | null; startTime: string | null; method: string; openRequest: boolean }[]>(`/attendance/students/${studentId}/records${qs({ page, pageSize: 20, status })}`) });
  const [req, setReq] = useState<{ id: string; status: AttendanceStatus; date: string; subjectName: string | null } | null>(null);
  const d = q.data?.data;
  return (
    <QueryState q={q} rows={6}>
      {d && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Attendance" value={fmtPct(d.overall.percentage)} tone={d.overall.band === 'shortage' ? 'bad' : d.overall.band === 'warning' ? 'warn' : 'good'} hint={<Badge className={BAND_META[d.overall.band].cls}>{BAND_META[d.overall.band].label}</Badge>} />
            <Stat label="Attended / counted" value={`${d.overall.attended} / ${d.overall.conducted}`} hint={d.overall.excluded ? `${d.overall.excluded} excluded (leave, etc.)` : undefined} />
            <Stat label={d.overall.band === 'shortage' ? 'Sessions needed' : 'Can still miss'} value={d.overall.band === 'shortage' ? (d.overall.sessionsNeeded ?? '—') : d.overall.maxMissable} hint={`to stay at ${d.policy.eligibilityThreshold}%`} />
            <Stat label="Late arrivals" value={d.lateCount} hint={d.consecutiveAbsence.current ? `${d.consecutiveAbsence.current} consecutive absent days` : `Longest absence run: ${d.consecutiveAbsence.longest} days`} />
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Subject-wise attendance" className="lg:col-span-2" bodyClass="p-0">
              {!d.bySubject.length ? <Empty title="No subject-wise records" hint="This institution records a daily register." /> : (
                <div className="overflow-x-auto"><table className="w-full min-w-[520px]">
                  <thead className="bg-slate-50"><tr><th className="th">Subject</th><th className="th text-right">Attended</th><th className="th text-right">Counted</th><th className="th w-1/3">%</th><th className="th">Status</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">{d.bySubject.map((s) => (
                    <tr key={s.subjectId}><td className="td"><div className="font-medium">{s.name}</div><div className="text-xs text-slate-500">{s.code} · {s.kind}</div></td><td className="td text-right tabular-nums">{s.attended}</td><td className="td text-right tabular-nums">{s.conducted}</td>
                      <td className="td"><div className="flex items-center gap-2"><span className="w-14 text-right tabular-nums">{fmtPct(s.percentage)}</span><PctBar value={s.percentage} threshold={d.policy.eligibilityThreshold} /></div></td>
                      <td className="td"><Badge className={BAND_META[s.band].cls}>{BAND_META[s.band].label}</Badge></td></tr>))}</tbody>
                </table></div>
              )}
            </Card>
            <div className="space-y-5">
              <ShortageCalculator attended={d.overall.attended} conducted={d.overall.conducted} threshold={d.policy.eligibilityThreshold} />
              <Card title="Monthly">
                <ul className="space-y-2.5">{d.monthly.map((m) => <li key={m.month}><div className="mb-1 flex justify-between text-sm"><span>{new Date(`${m.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</span><span className="tabular-nums">{fmtPct(m.percentage)}</span></div><PctBar value={m.percentage} threshold={d.policy.eligibilityThreshold} /></li>)}</ul>
              </Card>
            </div>
          </div>
          <Card title="Attendance history" bodyClass="p-0" actions={<Select className="w-auto" value={status} onChange={(v) => { setStatus(v); setPage(1); }} placeholder="All statuses" options={Object.entries(STATUS_META).map(([k, v]) => ({ value: k, label: v.label }))} />}>
            <QueryState q={recs} empty={recs.data?.data.length === 0 ? <Empty title="No records" /> : undefined}>
              <ul className="divide-y divide-slate-100">{recs.data?.data.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="w-24 shrink-0 text-sm tabular-nums text-slate-600">{fmtDate(r.date)}</div>
                  <div className="min-w-0 flex-1 text-sm"><div className="truncate">{r.kind === 'daily' ? 'Daily register' : r.subjectName}</div>{r.periodName && <div className="text-xs text-slate-500">{r.periodName} {fmtTime(r.startTime)}</div>}</div>
                  <Badge className={STATUS_META[r.status].cls}>{STATUS_META[r.status].label}</Badge>
                  {canRequest && (r.openRequest ? <Badge>Request pending</Badge> : <Button size="sm" variant="ghost" onClick={() => setReq(r)}>Request correction</Button>)}
                </li>))}</ul>
              <Pagination meta={recs.data?.meta as never} onPage={setPage} />
            </QueryState>
          </Card>
          <p className="text-xs text-slate-500">{d.disclaimer} Calculation: {d.policy.calculationUnit === 'day' ? 'by day' : 'by session'}; late counts as {d.policy.lateWeight === 1 ? 'present' : `${d.policy.lateWeight} of a session`}; approved leave is {d.policy.approvedLeaveHandling === 'exclude' ? 'excluded' : `counted as ${d.policy.approvedLeaveHandling}`}.</p>
          {req && <RequestModal record={req} onClose={() => setReq(null)} studentId={studentId} />}
        </div>
      )}
    </QueryState>
  );
}

function ShortageCalculator({ attended, conducted, threshold }: { attended: number; conducted: number; threshold: number }) {
  const [upcoming, setUpcoming] = useState(20);
  const [miss, setMiss] = useState(2);
  useEffect(() => { if (miss > upcoming) setMiss(upcoming); }, [upcoming, miss]);
  const projected = useMemo(() => { const c = conducted + upcoming; return c ? ((attended + upcoming - miss) / c) * 100 : null; }, [attended, conducted, upcoming, miss]);
  return (
    <Card title="Shortage calculator">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Upcoming sessions"><input type="number" min={0} max={500} className="input" value={upcoming} onChange={(e) => setUpcoming(Math.max(0, Number(e.target.value)))} /></Field>
        <Field label="Sessions I'll miss"><input type="number" min={0} max={upcoming} className="input" value={miss} onChange={(e) => setMiss(Math.max(0, Math.min(upcoming, Number(e.target.value))))} /></Field>
      </div>
      <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">Projected attendance: <b className={projected !== null && projected < threshold ? 'text-red-700' : 'text-emerald-700'}>{fmtPct(projected)}</b> {projected !== null && projected < threshold ? `(below ${threshold}%)` : `(meets ${threshold}%)`}</div>
    </Card>
  );
}

function RequestModal({ record, onClose, studentId }: { record: { id: string; status: AttendanceStatus; date: string; subjectName: string | null }; onClose: () => void; studentId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>('present');
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api.post('/attendance/correction-requests', { recordId: record.id, requestedStatus: status, reason }), onSuccess: () => { toast.success('Request sent to the teacher'); qc.invalidateQueries({ queryKey: ['records', studentId] }); onClose(); }, onError: (e) => toast.error(e) });
  return (
    <Modal open onClose={onClose} title="Request a correction" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={reason.trim().length < 10 || status === record.status} loading={m.isPending} onClick={() => m.mutate()}>Send request</Button></>}>
      <p className="text-sm text-slate-600">{fmtDate(record.date)} · {record.subjectName ?? 'Daily register'} · currently <b>{STATUS_META[record.status].label}</b>. Your teacher reviews the request; you cannot change attendance yourself.</p>
      <div className="mt-4 space-y-4">
        <Field label="Should be"><Select value={status} onChange={setStatus} options={(['present', 'late', 'on_leave', 'medical_leave', 'on_duty', 'excused'] as AttendanceStatus[]).map((s) => ({ value: s, label: STATUS_META[s].label }))} /></Field>
        <Field label="Reason" hint="At least 10 characters. Be specific."><textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
