import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, Check, History, QrCode, RotateCcw, Search, Users, WifiOff, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { STATUS_META, type AttendanceStatus } from '../../lib/types';
import { Badge, Button, Card, Confirm, Field, Modal, PageHeader, QueryState, Select, useToast } from '../../components/ui';
import { fmtDate, fmtDateTime, fmtTime } from '../../lib/format';
import { enqueue, flushQueue } from '../../lib/offline';

interface StudentRow { id: string; name: string; admissionNumber: string; rollNumber: string | null; photoUrl: string | null; leftRoster: boolean; record: { id: string; status: AttendanceStatus; remarks: string | null; method: string; version: number; markedAt: string } | null }
interface SessionData {
  session: { id: string; kind: string; sessionDate: string; status: 'open' | 'submitted' | 'locked' | 'cancelled'; courseOfferingId: string | null; sectionId: string | null; periodId: string | null; submittedAt: string | null; method: string; requiresVerification: boolean };
  subjectName?: string; subjectCode?: string; sectionName?: string; classLevelName?: string; periodName?: string; startTime?: string; endTime?: string;
  students: StudentRow[]; enabledStatuses: AttendanceStatus[]; deadline: string; canEdit: boolean; editWindowEndsAt: string | null;
}

export default function SessionMarking() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, context } = useAuth();
  const q = useQuery({ queryKey: ['session', id], queryFn: () => api.get<SessionData>(`/attendance/sessions/${id}`) });
  const d = q.data?.data;
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});
  const [history, setHistory] = useState<Record<string, AttendanceStatus>[]>([]);
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [edit, setEdit] = useState<StudentRow | null>(null);
  const [histFor, setHistFor] = useState<StudentRow | null>(null);
  const [queuedOffline, setQueuedOffline] = useState(false);
  const initialised = useRef(false);

  useEffect(() => {
    if (!d) return;
    const fromServer = Object.fromEntries(d.students.filter((s) => s.record).map((s) => [s.id, s.record!.status]));
    if (!initialised.current) { setMarks(fromServer); initialised.current = true; }
    else setMarks((m) => ({ ...fromServer, ...m, ...Object.fromEntries(d.students.filter((s) => s.record?.method === 'qr' && !m[s.id]).map((s) => [s.id, s.record!.status])) }));
  }, [d]);
  useEffect(() => { if (context && navigator.onLine) flushQueue(context.institutionId).catch(() => {}); }, [context]);

  const open = d?.session.status === 'open';
  const editable = open && d?.canEdit;
  const set = (patch: Record<string, AttendanceStatus>) => { setHistory((h) => [...h.slice(-30), marks]); setMarks((m) => ({ ...m, ...patch })); };
  const undo = () => { const prev = history.at(-1); if (prev) { setMarks(prev); setHistory((h) => h.slice(0, -1)); } };
  const roster = d?.students.filter((s) => !s.leftRoster) ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of roster) { const st = marks[s.id]; c[st ?? 'unmarked'] = (c[st ?? 'unmarked'] ?? 0) + 1; }
    return c;
  }, [marks, roster]);
  const filtered = (d?.students ?? []).filter((s) => !search || `${s.name} ${s.admissionNumber} ${s.rollNumber ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const payload = () => Object.entries(marks).filter(([sid]) => roster.some((r) => r.id === sid)).map(([studentId, status]) => ({ studentId, status }));

  const save = useMutation({ mutationFn: () => api.put(`/attendance/sessions/${id}/records`, { records: payload() }), onSuccess: () => toast.success('Draft saved'), onError: (e) => toast.error(e) });
  const submit = useMutation({
    mutationFn: () => api.post<{ tally: Record<string, number>; notified: number }>(`/attendance/sessions/${id}/submit`, { records: payload() }),
    onSuccess: (r) => { setConfirm(false); toast.success(`Attendance submitted${r.data.notified ? ` · ${r.data.notified} notification(s) sent` : ''}`); qc.invalidateQueries({ queryKey: ['session', id] }); qc.invalidateQueries({ queryKey: ['today'] }); },
    onError: (e) => {
      setConfirm(false);
      if (e instanceof ApiError && e.code === 'NETWORK' && d && context) {
        enqueue({ institutionId: context.institutionId, kind: d.session.kind, date: d.session.sessionDate, courseOfferingId: d.session.courseOfferingId, sectionId: d.session.courseOfferingId ? null : d.session.sectionId, periodId: d.session.periodId, records: payload(), label: `${d.subjectName ?? 'Register'} ${d.classLevelName ?? ''} ${d.sectionName ?? ''}` });
        setQueuedOffline(true);
        toast.info('You are offline. Attendance saved on this device and will sync when you reconnect.');
      } else toast.error(e);
    },
  });
  useEffect(() => {
    const on = async () => { if (!context) return; const r = await flushQueue(context.institutionId).catch(() => null); if (r?.applied) { toast.success(`${r.applied} offline submission(s) synced`); setQueuedOffline(false); qc.invalidateQueries({ queryKey: ['session', id] }); } if (r?.conflicts.length) toast.error(`${r.conflicts.length} offline submission(s) conflicted with attendance already submitted online and were not applied.`); };
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [context, id, qc, toast]);

  const title = d ? (d.subjectName ? `${d.subjectName}` : d.session.kind === 'daily' ? 'Daily register' : d.session.kind) : 'Attendance';
  const quick: AttendanceStatus[] = ['present', 'absent', 'late'].filter((s) => d?.enabledStatuses.includes(s as AttendanceStatus)) as AttendanceStatus[];
  const extra = (d?.enabledStatuses ?? []).filter((s) => !quick.includes(s));
  const unmarked = counts.unmarked ?? 0;

  return (
    <div className="pb-24">
      <Link to="/attendance" className="no-print mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" />Back</Link>
      <QueryState q={q} rows={8}>
        {d && (
          <>
            <PageHeader title={title} subtitle={<span>{[d.classLevelName && `${d.classLevelName} ${d.sectionName ?? ''}`, d.periodName && `${d.periodName} ${fmtTime(d.startTime)}–${fmtTime(d.endTime)}`, fmtDate(d.session.sessionDate)].filter(Boolean).join(' · ')}</span>}
              actions={<>
                <Badge className={d.session.status === 'open' ? 'bg-amber-100 text-amber-800' : d.session.status === 'cancelled' ? 'bg-slate-200 text-slate-700' : 'bg-emerald-100 text-emerald-800'}>{d.session.status === 'open' ? 'Not submitted' : d.session.status}</Badge>
                {editable && can('attendance.take', 'attendance.take.any') && <Button variant="outline" onClick={() => setQrOpen(true)}><QrCode className="h-4 w-4" />QR attendance</Button>}
              </>} />
            {queuedOffline && <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"><WifiOff className="h-4 w-4" />Saved on this device — will sync automatically when you are back online. Do not clear browser data until then.</div>}
            {d.session.requiresVerification && <div className="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">Captured offline with an unverified device timestamp — flagged for administrator verification.</div>}
            {open && !d.canEdit && <div className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">View only — this class is not assigned to you.</div>}
            {open && <p className="mb-3 text-xs text-slate-500">Submission deadline: {fmtDateTime(d.deadline)}</p>}

            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Count label="Students" n={roster.length} icon={<Users className="h-4 w-4" />} />
              <Count label="Present" n={(counts.present ?? 0)} cls="text-emerald-700" />
              <Count label="Absent" n={counts.absent ?? 0} cls="text-red-700" />
              <Count label="Late" n={counts.late ?? 0} cls="text-amber-700" />
              <Count label="Unmarked" n={unmarked} cls={unmarked ? 'text-slate-900' : 'text-slate-400'} />
            </div>

            <Card bodyClass="p-0">
              <div className="no-print flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
                <div className="relative min-w-[180px] flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><input className="input pl-9" placeholder="Search name, roll or admission no." value={search} onChange={(e) => setSearch(e.target.value)} /></div>
                {editable && <>
                  <Button variant="success" onClick={() => set(Object.fromEntries(roster.map((s) => [s.id, 'present' as AttendanceStatus])))}><Check className="h-4 w-4" />All present</Button>
                  <Button variant="outline" onClick={() => set(Object.fromEntries(roster.filter((s) => !marks[s.id]).map((s) => [s.id, 'present' as AttendanceStatus])))}>Unmarked → present</Button>
                  <Button variant="outline" onClick={() => set(Object.fromEntries(roster.map((s) => [s.id, 'absent' as AttendanceStatus])))}>All absent</Button>
                  <Button variant="ghost" onClick={undo} disabled={!history.length} aria-label="Undo"><RotateCcw className="h-4 w-4" />Undo</Button>
                </>}
              </div>
              <ul className="divide-y divide-slate-100">
                {filtered.map((s) => {
                  const st = marks[s.id];
                  return (
                    <li key={s.id} className={clsx('flex flex-wrap items-center gap-3 px-3 py-2.5 sm:flex-nowrap', st === 'absent' && 'bg-red-50/40')}>
                      <div className="w-8 text-center text-xs font-medium tabular-nums text-slate-400">{s.rollNumber ?? '–'}</div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{s.name}{s.leftRoster && <Badge className="ml-2">left class</Badge>}{s.record?.method === 'qr' && <Badge className="ml-2 bg-teal-100 text-teal-800">QR</Badge>}</div>
                        <div className="text-xs text-slate-500">{s.admissionNumber}</div>
                      </div>
                      {editable && !s.leftRoster ? (
                        <div className="flex items-center gap-1.5">
                          {quick.map((k) => (
                            <button key={k} onClick={() => set({ [s.id]: k })} aria-pressed={st === k} aria-label={`${STATUS_META[k].label} – ${s.name}`}
                              className={clsx('h-10 min-w-10 rounded-lg border px-2 text-sm font-semibold transition', st === k ? STATUS_META[k].cls + ' ring-2 ring-offset-1 ring-current' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50')}>{STATUS_META[k].short}</button>
                          ))}
                          {extra.length > 0 && <select className="h-10 rounded-lg border border-slate-200 bg-white px-1 text-xs" value={extra.includes(st) ? st : ''} onChange={(e) => e.target.value && set({ [s.id]: e.target.value as AttendanceStatus })} aria-label="Other status"><option value="">More…</option>{extra.map((x) => <option key={x} value={x}>{STATUS_META[x].label}</option>)}</select>}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          {st ? <Badge className={STATUS_META[st].cls}>{STATUS_META[st].label}</Badge> : <Badge>Not marked</Badge>}
                          {s.record && !open && (d.canEdit || can('attendance.correct')) && <Button size="sm" variant="ghost" onClick={() => setEdit(s)}>Correct</Button>}
                          {s.record && !open && <button className="rounded p-1 text-slate-400 hover:text-slate-700" onClick={() => setHistFor(s)} aria-label="Change history"><History className="h-4 w-4" /></button>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>

            {editable && (
              <div className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:left-auto md:right-0 md:w-[calc(100%-16rem)]">
                <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
                  <span className="text-sm text-slate-600">{unmarked ? `${unmarked} still unmarked` : 'Everyone marked'}</span>
                  <div className="flex gap-2"><Button variant="outline" onClick={() => save.mutate()} loading={save.isPending}>Save draft</Button><Button onClick={() => setConfirm(true)} disabled={unmarked > 0}>Review & submit</Button></div>
                </div>
              </div>
            )}
            <Confirm open={confirm} onClose={() => setConfirm(false)} onConfirm={() => submit.mutate()} loading={submit.isPending} title="Submit attendance?" confirmLabel="Submit"
              message={<div><p>{roster.length} students: {Object.entries(counts).filter(([k]) => k !== 'unmarked').map(([k, n]) => `${n} ${STATUS_META[k as AttendanceStatus]?.label.toLowerCase()}`).join(', ')}.</p><p className="mt-2">Guardians of absent and late students will be notified according to institution settings. After submission, changes are recorded as corrections with an audit trail.</p></div>} />
            {qrOpen && <QrPanel sessionId={d.session.id} onClose={() => { setQrOpen(false); q.refetch(); }} onProgress={() => q.refetch()} />}
            {edit && <CorrectModal row={edit} statuses={d.enabledStatuses} onClose={() => setEdit(null)} onDone={() => { setEdit(null); initialised.current = false; q.refetch(); }} windowEnds={d.editWindowEndsAt} />}
            {histFor?.record && <HistoryModal recordId={histFor.record.id} name={histFor.name} onClose={() => setHistFor(null)} />}
          </>
        )}
      </QueryState>
    </div>
  );
}

const Count = ({ label, n, cls, icon }: { label: string; n: number; cls?: string; icon?: React.ReactNode }) => (
  <div className="card px-3 py-2"><div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}{icon}</div><div className={clsx('text-xl font-semibold tabular-nums', cls)}>{n}</div></div>
);

function QrPanel({ sessionId, onClose, onProgress }: { sessionId: string; onClose: () => void; onProgress: () => void }) {
  const toast = useToast();
  const [qrId, setQrId] = useState<string | null>(null);
  const [rotation, setRotation] = useState(15);
  const startM = useMutation({ mutationFn: () => api.post<{ id: string }>('/attendance/qr/sessions', { attendanceSessionId: sessionId, rotationSeconds: rotation, durationMinutes: 10 }), onSuccess: (r) => setQrId(r.data.id), onError: (e) => toast.error(e) });
  const tok = useQuery({ queryKey: ['qr', qrId], queryFn: () => api.get<{ active: boolean; qrDataUrl?: string; secondsLeft?: number; progress: { scanned: number; roster: number }; suspicious: number; expiresAt: string }>(`/attendance/qr/sessions/${qrId}/token`), enabled: !!qrId, refetchInterval: 3000 });
  const scanned = tok.data?.data.progress.scanned;
  useEffect(() => { if (scanned !== undefined) onProgress(); }, [scanned]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = async () => { if (qrId) await api.post(`/attendance/qr/sessions/${qrId}/close`).catch(() => {}); onClose(); };
  const t = tok.data?.data;
  return (
    <Modal open onClose={close} title="QR attendance" wide footer={<Button variant="outline" onClick={close}>{qrId ? 'Stop QR & review' : 'Close'}</Button>}>
      {!qrId ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Students scan the code with their AttendIQ account. The code changes every few seconds so a photo shared outside the room stops working quickly. You still review and submit — a scan is evidence, not proof of presence.</p>
          <Field label="Rotate code every"><Select value={String(rotation)} onChange={(v) => setRotation(Number(v))} options={[10, 15, 20, 30].map((s) => ({ value: String(s), label: `${s} seconds` }))} /></Field>
          <Button onClick={() => startM.mutate()} loading={startM.isPending}><QrCode className="h-4 w-4" />Start QR window (10 min)</Button>
        </div>
      ) : !t ? <p className="text-sm text-slate-500">Generating code…</p> : t.active ? (
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          <img src={t.qrDataUrl} alt="Attendance QR code" className="w-72 max-w-full rounded-xl border border-slate-200" />
          <div className="flex-1 space-y-3">
            <div className="text-4xl font-semibold tabular-nums text-brand-700">{t.progress.scanned}<span className="text-lg text-slate-400"> / {t.progress.roster}</span></div>
            <p className="text-sm text-slate-500">students recorded via QR</p>
            <p className="text-sm text-slate-500">Code refreshes in ~{t.secondsLeft}s · window closes {fmtDateTime(t.expiresAt)}</p>
            {t.suspicious > 0 && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{t.suspicious} network(s) submitted scans for more than 3 students. Verify those students are in the room.</div>}
          </div>
        </div>
      ) : <p className="text-sm text-slate-600">This QR window has closed. {t.progress.scanned} students were recorded.</p>}
    </Modal>
  );
}

function CorrectModal({ row, statuses, onClose, onDone, windowEnds }: { row: StudentRow; statuses: AttendanceStatus[]; onClose: () => void; onDone: () => void; windowEnds: string | null }) {
  const toast = useToast();
  const [status, setStatus] = useState<string>(row.record!.status);
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api.patch(`/attendance/records/${row.record!.id}`, { status, reason, expectedVersion: row.record!.version }), onSuccess: () => { toast.success('Correction recorded'); onDone(); }, onError: (e) => toast.error(e) });
  return (
    <Modal open onClose={onClose} title={`Correct attendance · ${row.name}`} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={status === row.record!.status || reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()}>Save correction</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">Current: <b>{STATUS_META[row.record!.status].label}</b>. The original value is kept in the audit history.{windowEnds && ` Teacher edit window ends ${fmtDateTime(windowEnds)}.`}</p>
        <Field label="New status"><Select value={status} onChange={setStatus} options={statuses.map((s) => ({ value: s, label: STATUS_META[s].label }))} /></Field>
        <Field label="Reason (required)"><textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function HistoryModal({ recordId, name, onClose }: { recordId: string; name: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['record-history', recordId], queryFn: () => api.get<{ record: { status: AttendanceStatus }; history: { id: string; oldStatus: AttendanceStatus; newStatus: AttendanceStatus; reason: string; changedBy: string | null; createdAt: string }[] }>(`/attendance/records/${recordId}/history`) });
  return (
    <Modal open onClose={onClose} title={`Change history · ${name}`}>
      <QueryState q={q} empty={q.data?.data.history.length === 0 ? <p className="text-sm text-slate-500">No changes since submission.</p> : undefined}>
        <ol className="space-y-3">
          {q.data?.data.history.map((h) => (
            <li key={h.id} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex items-center gap-2"><Badge className={STATUS_META[h.oldStatus].cls}>{STATUS_META[h.oldStatus].label}</Badge>→<Badge className={STATUS_META[h.newStatus].cls}>{STATUS_META[h.newStatus].label}</Badge></div>
              <p className="mt-1.5 text-slate-700">{h.reason}</p>
              <p className="mt-1 text-xs text-slate-500">{h.changedBy ?? 'Unknown'} · {fmtDateTime(h.createdAt)}</p>
            </li>
          ))}
        </ol>
      </QueryState>
    </Modal>
  );
}
void X;
