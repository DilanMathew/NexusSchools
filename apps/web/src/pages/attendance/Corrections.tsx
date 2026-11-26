import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { STATUS_META, type AttendanceStatus } from '../../lib/types';
import { Badge, Button, Card, Empty, Field, Modal, PageHeader, Pagination, QueryState, Tabs, useToast } from '../../components/ui';
import { fmtDate, fmtDateTime } from '../../lib/format';

interface CR { id: string; status: string; requestedStatus: AttendanceStatus; currentStatus: AttendanceStatus; reason: string; reviewNote: string | null; createdAt: string; sessionDate: string; subjectName: string | null; studentName: string; admissionNumber: string; requestedBy: string | null }

export default function Corrections() {
  const { can } = useAuth();
  const reviewer = can('attendance.corrections.review', 'attendance.correct');
  const [tab, setTab] = useState<'pending' | 'info_requested' | 'approved' | 'rejected' | ''>('pending');
  const [page, setPage] = useState(1);
  const [review, setReview] = useState<CR | null>(null);
  const q = useQuery({ queryKey: ['corrections', tab, page], queryFn: () => api.get<CR[]>(`/attendance/correction-requests${qs({ status: tab, page })}`) });
  return (
    <div>
      <PageHeader title={reviewer ? 'Attendance corrections' : 'My correction requests'} subtitle={reviewer ? 'Review requests from students and guardians. Approved changes keep the original value in the audit history.' : 'Raise a request from My attendance. Your teacher reviews it.'} />
      <Tabs value={tab} onChange={(t) => { setTab(t); setPage(1); }} tabs={[{ key: 'pending', label: 'Pending' }, { key: 'info_requested', label: 'Info requested' }, { key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Rejected' }, { key: '', label: 'All' }]} />
      <Card bodyClass="p-0">
        <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No requests" /> : undefined}>
          <ul className="divide-y divide-slate-100">
            {q.data?.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{r.studentName} <span className="font-normal text-slate-500">· {r.admissionNumber}</span></div>
                  <div className="mt-0.5 text-xs text-slate-500">{fmtDate(r.sessionDate)} · {r.subjectName ?? 'Daily register'} · requested by {r.requestedBy} · {fmtDateTime(r.createdAt)}</div>
                  <div className="mt-1.5 flex items-center gap-2 text-sm"><Badge className={STATUS_META[r.currentStatus].cls}>{STATUS_META[r.currentStatus].label}</Badge>→<Badge className={STATUS_META[r.requestedStatus].cls}>{STATUS_META[r.requestedStatus].label}</Badge></div>
                  <p className="mt-1.5 text-sm text-slate-700">“{r.reason}”</p>
                  {r.reviewNote && <p className="mt-1 text-sm text-slate-500">Reviewer: {r.reviewNote}</p>}
                </div>
                <div className="flex items-center gap-2"><Badge>{r.status.replace('_', ' ')}</Badge>{reviewer && ['pending', 'info_requested'].includes(r.status) && <Button size="sm" onClick={() => setReview(r)}>Review</Button>}</div>
              </li>
            ))}
          </ul>
          <Pagination meta={q.data?.meta as never} onPage={setPage} />
        </QueryState>
      </Card>
      {review && <ReviewModal r={review} onClose={() => setReview(null)} />}
    </div>
  );
}

function ReviewModal({ r, onClose }: { r: CR; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: (decision: string) => api.post(`/attendance/correction-requests/${r.id}/review`, { decision, note: note || undefined }), onSuccess: () => { toast.success('Decision recorded'); qc.invalidateQueries({ queryKey: ['corrections'] }); onClose(); }, onError: (e) => toast.error(e) });
  return (
    <Modal open onClose={onClose} title={`Review request · ${r.studentName}`} footer={<>
      <Button variant="outline" disabled={!note} loading={m.isPending} onClick={() => m.mutate('info_requested')}>Ask for info</Button>
      <Button variant="danger" disabled={!note} loading={m.isPending} onClick={() => m.mutate('rejected')}>Reject</Button>
      <Button variant="success" loading={m.isPending} onClick={() => m.mutate('approved')}>Approve</Button></>}>
      <p className="text-sm text-slate-600">Change {fmtDate(r.sessionDate)} {r.subjectName ?? ''} from <b>{STATUS_META[r.currentStatus].label}</b> to <b>{STATUS_META[r.requestedStatus].label}</b>.</p>
      <p className="mt-2 rounded-lg bg-slate-50 p-3 text-sm">“{r.reason}”</p>
      <div className="mt-4"><Field label="Note to the requester" hint="Required to reject or request information."><textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
    </Modal>
  );
}
