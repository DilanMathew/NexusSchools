import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { api, ApiError, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Card, Empty, Field, Modal, PageHeader, QueryState, Select, useToast } from '../../components/ui';
import { useSectionOptions, useStaffLite, useSubjects } from '../../lib/lookups';
import { DAYS, fmtTime } from '../../lib/format';

interface Period { id: string; name: string; ordinal: number; startTime: string; endTime: string; isBreak: boolean }
interface Entry { id: string; dayOfWeek: number; periodId: string; roomId: string | null; roomName: string | null; offeringId: string; subjectName: string; subjectCode: string; subjectKind: string; staffName: string | null; sectionId: string | null; sectionName: string | null; classLevelName: string | null }

export default function Timetable() {
  const { can, context } = useAuth();
  const manage = can('timetable.manage');
  const browse = manage || can('academic.read');
  const sections = useSectionOptions(browse);
  const staff = useStaffLite(browse && can('staff.read', 'staff.manage', 'academic.manage'));
  const rooms = useQuery({ queryKey: ['lookup', 'rooms'], queryFn: async () => (await api.get<{ id: string; name: string }[]>('/academic/rooms?pageSize=200')).data, enabled: browse });
  const [mode, setMode] = useState<'section' | 'staff' | 'room'>(context?.staffId && !manage ? 'staff' : 'section');
  const [target, setTarget] = useState<string>('');
  const effective = target || (mode === 'staff' ? context?.staffId ?? '' : '');
  const param = !browse ? {} : mode === 'section' ? { sectionId: effective || sections.options[0]?.value } : mode === 'staff' ? { staffId: effective } : { roomId: effective };
  const ready = !browse || !!Object.values(param)[0];
  const q = useQuery({ queryKey: ['timetable', param], queryFn: () => api.get<{ periods: Period[]; entries: Entry[] }>(`/timetable${qs(param)}`), enabled: ready });
  const conflicts = useQuery({ queryKey: ['tt-conflicts'], queryFn: () => api.get<{ entryId: string; kind: string; message: string }[]>('/timetable/conflicts'), enabled: manage });
  const qc = useQueryClient();
  const toast = useToast();
  const [add, setAdd] = useState<{ dow: number; periodId: string } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: (v: { id: string; dayOfWeek: number; periodId: string }) => api.patch(`/timetable/entries/${v.id}`, { dayOfWeek: v.dayOfWeek, periodId: v.periodId }),
    onSuccess: () => { toast.success('Moved'); qc.invalidateQueries({ queryKey: ['timetable'] }); qc.invalidateQueries({ queryKey: ['tt-conflicts'] }); },
    onError: (e) => toast.error(e),
  });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/timetable/entries/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['timetable'] }); qc.invalidateQueries({ queryKey: ['tt-conflicts'] }); } });
  const days = [1, 2, 3, 4, 5, 6];
  const d = q.data?.data;
  const conflictIds = new Set((conflicts.data?.data ?? []).map((c) => c.entryId));
  const canEditGrid = manage && mode === 'section';
  const targetOptions = mode === 'section' ? sections.options : mode === 'staff' ? (staff.data ?? []).map((s) => ({ value: s.id, label: s.fullName })) : (rooms.data ?? []).map((r) => ({ value: r.id, label: r.name }));
  return (
    <div>
      <PageHeader title="Timetable" subtitle={manage ? 'Click an empty slot to schedule; drag a class to move it. Faculty, room and class clashes are blocked.' : 'Your weekly schedule.'}
        actions={browse && <>
          <Select className="w-auto" value={mode} onChange={(v) => { setMode(v as typeof mode); setTarget(''); }} options={[{ value: 'section', label: 'By class' }, { value: 'staff', label: 'By faculty' }, { value: 'room', label: 'By room' }]} />
          <Select className="w-auto min-w-[180px]" value={String(Object.values(param)[0] ?? '')} onChange={setTarget} placeholder="Select…" options={targetOptions} />
        </>} />
      {manage && (conflicts.data?.data.length ?? 0) > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"><AlertTriangle className="mr-1 inline h-4 w-4" />{conflicts.data!.data.length} existing clash(es) in the current timetable: {[...new Set(conflicts.data!.data.map((c) => c.message))].join('; ')}. Clashing slots are outlined in red.</div>
      )}
      <Card bodyClass="p-0">
        {!ready ? <Empty title="Choose a class, faculty member or room" /> : (
          <QueryState q={q} empty={d && !d.periods.length ? <Empty title="No periods configured" hint="Set up the bell schedule under Academic setup → Periods." /> : undefined}>
            {d && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] table-fixed border-collapse">
                  <thead><tr className="bg-slate-50"><th className="th w-28">Period</th>{days.map((x) => <th key={x} className="th text-center">{DAYS[x - 1]}</th>)}</tr></thead>
                  <tbody>{d.periods.map((p) => (
                    <tr key={p.id} className={clsx('border-t border-slate-100', p.isBreak && 'bg-slate-50')}>
                      <td className="px-3 py-2 align-top text-xs"><div className="font-medium text-slate-700">{p.name}</div><div className="text-slate-500">{fmtTime(p.startTime)}–{fmtTime(p.endTime)}</div></td>
                      {days.map((dow) => {
                        const es = d.entries.filter((e) => e.dayOfWeek === dow && e.periodId === p.id);
                        if (p.isBreak) return <td key={dow} className="px-1 py-1 text-center text-[11px] uppercase tracking-wide text-slate-400">—</td>;
                        return (
                          <td key={dow} className="h-16 px-1 py-1 align-top" onDragOver={(e) => canEditGrid && e.preventDefault()} onDrop={() => { if (drag && canEditGrid) { move.mutate({ id: drag, dayOfWeek: dow, periodId: p.id }); setDrag(null); } }}>
                            {es.map((e) => (
                              <div key={e.id} draggable={canEditGrid} onDragStart={() => setDrag(e.id)} className={clsx('group relative mb-1 rounded-md border px-2 py-1 text-xs', e.subjectKind === 'lab' ? 'border-teal-200 bg-teal-50' : 'border-brand-100 bg-brand-50', conflictIds.has(e.id) && 'ring-2 ring-red-400', canEditGrid && 'cursor-move')}>
                                <div className="truncate font-semibold text-slate-800">{e.subjectName}</div>
                                <div className="truncate text-slate-500">{mode === 'section' ? e.staffName : `${e.classLevelName ?? ''} ${e.sectionName ?? ''}`}{e.roomName && ` · ${e.roomName}`}</div>
                                {manage && <button onClick={() => del.mutate(e.id)} className="absolute right-1 top-1 hidden rounded p-0.5 text-slate-400 hover:text-red-600 group-hover:block" aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button>}
                              </div>
                            ))}
                            {canEditGrid && !es.length && <button onClick={() => setAdd({ dow, periodId: p.id })} className="flex h-full min-h-12 w-full items-center justify-center rounded-md border border-dashed border-transparent text-slate-300 hover:border-slate-300 hover:text-slate-500" aria-label={`Schedule ${DAYS[dow - 1]} ${p.name}`}><Plus className="h-4 w-4" /></button>}
                          </td>
                        );
                      })}
                    </tr>))}</tbody>
                </table>
              </div>
            )}
          </QueryState>
        )}
      </Card>
      {add && <AddEntry slot={add} sectionId={String(param.sectionId ?? '')} rooms={rooms.data ?? []} periods={d?.periods ?? []} onClose={() => setAdd(null)} />}
    </div>
  );
}

function AddEntry({ slot, sectionId, rooms, periods, onClose }: { slot: { dow: number; periodId: string }; sectionId: string; rooms: { id: string; name: string }[]; periods: Period[]; onClose: () => void }) {
  const offerings = useQuery({ queryKey: ['offerings', sectionId], queryFn: () => api.get<{ id: string; subjectId: string; staffId: string | null }[]>(`/academic/offerings?sectionId=${sectionId}&pageSize=100`) });
  const subjects = useSubjects(); const staff = useStaffLite();
  const [offeringId, setOffering] = useState('');
  const [roomId, setRoom] = useState('');
  const [conflicts, setConflicts] = useState<{ kind: string; message: string }[] | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const body = { courseOfferingId: offeringId, dayOfWeek: slot.dow, periodId: slot.periodId, roomId: roomId || null };
  const check = async () => { const r = await api.post<{ conflicts: { kind: string; message: string }[] }>('/timetable/check', body); setConflicts(r.data.conflicts); };
  const save = useMutation({ mutationFn: () => api.post('/timetable/entries', body), onSuccess: () => { toast.success('Scheduled'); qc.invalidateQueries({ queryKey: ['timetable'] }); onClose(); }, onError: (e) => { if (e instanceof ApiError && Array.isArray(e.details)) setConflicts(e.details as never); else toast.error(e); } });
  const p = periods.find((x) => x.id === slot.periodId);
  return (
    <Modal open onClose={onClose} title={`Schedule · ${DAYS[slot.dow - 1]} ${p?.name ?? ''}`} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="outline" disabled={!offeringId} onClick={check}>Check clashes</Button><Button disabled={!offeringId} loading={save.isPending} onClick={() => save.mutate()}>Schedule</Button></>}>
      <div className="space-y-4">
        <Field label="Subject (allocated to this class)"><Select value={offeringId} onChange={(v) => { setOffering(v); setConflicts(null); }} placeholder="Select…" options={(offerings.data?.data ?? []).map((o) => ({ value: o.id, label: `${subjects.data?.find((s) => s.id === o.subjectId)?.name ?? 'Subject'} — ${staff.data?.find((s) => s.id === o.staffId)?.fullName ?? 'no faculty'}` }))} /></Field>
        <Field label="Room (optional)"><Select value={roomId} onChange={(v) => { setRoom(v); setConflicts(null); }} placeholder="No room" options={rooms.map((r) => ({ value: r.id, label: r.name }))} /></Field>
        {offerings.data?.data.length === 0 && <p className="text-sm text-amber-700">No subjects are allocated to this class yet. Add them under Academic setup → Subject allocation.</p>}
        {conflicts && (conflicts.length ? <ul className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{conflicts.map((c, i) => <li key={i}>• {c.message}</li>)}</ul> : <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">No clashes.</p>)}
      </div>
    </Modal>
  );
}
