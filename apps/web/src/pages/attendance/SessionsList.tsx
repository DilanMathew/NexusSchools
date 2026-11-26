import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../lib/api';
import { Badge, Card, Empty, PageHeader, Pagination, QueryState, Select } from '../../components/ui';
import { fmtDate } from '../../lib/format';

interface Row { id: string; sessionDate: string; kind: string; status: string; method: string; subjectName: string | null; sectionName: string | null; classLevelName: string | null; periodName: string | null; takenBy: string | null; present: number; absent: number; marked: number; requiresVerification: boolean }

export default function SessionsList() {
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['sessions', page, from, to, status], queryFn: () => api.get<Row[]>(`/attendance/sessions${qs({ page, pageSize: 25, from, to, status })}`) });
  return (
    <div>
      <PageHeader title="Attendance records" subtitle="Every session taken in your scope, with who took it and how." />
      <Card bodyClass="p-0">
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <input type="date" className="input w-auto" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} aria-label="From" />
          <input type="date" className="input w-auto" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} aria-label="To" />
          <Select className="w-auto" value={status} onChange={(v) => { setStatus(v); setPage(1); }} placeholder="All statuses" options={['open', 'submitted', 'cancelled'].map((s) => ({ value: s, label: s }))} />
        </div>
        <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No sessions match" /> : undefined}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead className="bg-slate-50"><tr><th className="th">Date</th><th className="th">Class</th><th className="th">Session</th><th className="th">Taken by</th><th className="th text-right">Present</th><th className="th text-right">Absent</th><th className="th">Status</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {q.data?.data.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="td whitespace-nowrap"><Link className="font-medium text-brand-700 hover:underline" to={`/attendance/session/${r.id}`}>{fmtDate(r.sessionDate)}</Link></td>
                    <td className="td">{r.classLevelName} {r.sectionName}</td>
                    <td className="td">{r.kind === 'daily' ? 'Daily register' : r.subjectName}{r.periodName && <span className="text-slate-400"> · {r.periodName}</span>}</td>
                    <td className="td">{r.takenBy ?? '—'}</td>
                    <td className="td text-right tabular-nums">{r.present}</td>
                    <td className="td text-right tabular-nums">{r.absent}</td>
                    <td className="td"><Badge className={r.status === 'submitted' ? 'bg-emerald-100 text-emerald-800' : r.status === 'open' ? 'bg-amber-100 text-amber-800' : ''}>{r.status}</Badge>{r.method !== 'manual' && <Badge className="ml-1">{r.method}</Badge>}{r.requiresVerification && <Badge className="ml-1 bg-yellow-100 text-yellow-800">verify</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination meta={q.data?.meta as never} onPage={setPage} />
        </QueryState>
      </Card>
    </div>
  );
}
