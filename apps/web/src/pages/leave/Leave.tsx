import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Empty, Field, Modal, PageHeader, Pagination, QueryState, Tabs, useToast } from '../../components/ui';
import { FormModal } from '../../components/FormModal';
import { useMyStudents } from '../portal/MyAttendance';
import { fmtDate, fmtDateTime } from '../../lib/format';

interface LR { id: string; studentName: string; admissionNumber: string; typeName: string; startDate: string; endDate: string; reason: string; status: string; reviewNote: string | null; requestedBy: string | null; createdAt: string; requestedByUserId: string }
interface SLR { id: string; staffName: string; leaveType: string; startDate: string; endDate: string; reason: string; status: string; reviewNote: string | null; staffId: string }
const statusCls: Record<string, string> = { pending: 'bg-amber-100 text-amber-800', approved: 'bg-emerald-100 text-emerald-800', rejected: 'bg-red-100 text-red-800', cancelled: 'bg-slate-100 text-slate-600' };

export default function Leave() {
  const { can, context } = useAuth();
  const reviewer = can('leave.review');
  const isStaff = !!context?.staffId;
  const [tab, setTab] = useState<'students' | 'staff'>(isStaff && !reviewer ? 'staff' : 'students');
  return (
    <div>
      <PageHeader title="Leave" subtitle="Approving leave records the decision. Attendance percentages treat leave according to your institution's policy; records are not rewritten." />
      {isStaff && <Tabs value={tab} onChange={setTab} tabs={[{ key: 'students', label: 'Student leave' }, { key: 'staff', label: reviewer ? 'Staff leave' : 'My leave' }]} />}
      {tab === 'students' ? <StudentLeave /> : <StaffLeave />}
    </div>
  );
}

function StudentLeave() {
  const { can, user } = useAuth();
  const reviewer = can('leave.review');
  const portal = can('attendance.self.read', 'attendance.child.read');
  const [status, setStatus] = useState<string>(reviewer ? 'pending' : '');
  const [page, setPage] = useState(1);
  const [apply, setApply] = useState(false);
  const [review, setReview] = useState<LR | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const kids = useMyStudents();
  const types = useQuery({ queryKey: ['leave-types'], queryFn: () => api.get<{ id: string; name: string }[]>('/leave/types'), enabled: apply });
  const q = useQuery({ queryKey: ['leave', status, page], queryFn: () => api.get<LR[]>(`/leave/requests${qs({ status, page })}`) });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/leave/requests/${id}/cancel`), onSuccess: () => { toast.success('Cancelled'); qc.invalidateQueries({ queryKey: ['leave'] }); }, onError: (e) => toast.error(e) });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">{['pending', 'approved', 'rejected', ''].map((s) => <button key={s} onClick={() => { setStatus(s); setPage(1); }} className={`rounded-full px-3 py-1 text-sm ${status === s ? 'bg-brand-700 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200'}`}>{s || 'All'}</button>)}</div>
        {portal && <Button onClick={() => setApply(true)}><Plus className="h-4 w-4" />Apply for leave</Button>}
      </div>
      <Card bodyClass="p-0">
        <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No leave requests" /> : undefined}>
          <ul className="divide-y divide-slate-100">{q.data?.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{r.studentName} <span className="font-normal text-slate-500">· {r.admissionNumber}</span></div>
                <div className="text-xs text-slate-500">{r.typeName} · {fmtDate(r.startDate)}{r.endDate !== r.startDate && ` – ${fmtDate(r.endDate)}`} · requested by {r.requestedBy} {fmtDateTime(r.createdAt)}</div>
                <p className="mt-1 text-sm text-slate-700">{r.reason}</p>
                {r.reviewNote && <p className="mt-1 text-sm text-slate-500">Note: {r.reviewNote}</p>}
              </div>
              <Badge className={statusCls[r.status]}>{r.status}</Badge>
              {reviewer && r.status === 'pending' && <Button size="sm" onClick={() => setReview(r)}>Review</Button>}
              {r.status === 'pending' && r.requestedByUserId === user?.id && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>Cancel</Button>}
            </li>))}</ul>
          <Pagination meta={q.data?.meta as never} onPage={setPage} />
        </QueryState>
      </Card>
      <FormModal open={apply} onClose={() => setApply(false)} title="Apply for leave" submitLabel="Submit request" initial={{ studentId: kids.data?.data[0]?.id ?? '' }}
        fields={[
          { name: 'studentId', label: 'Student', type: 'select', required: true, options: (kids.data?.data ?? []).map((k) => ({ value: k.id, label: k.name })) },
          { name: 'leaveTypeId', label: 'Leave type', type: 'select', required: true, options: (types.data?.data ?? []).map((t) => ({ value: t.id, label: t.name })) },
          { name: 'startDate', label: 'From', type: 'date', required: true, half: true }, { name: 'endDate', label: 'To', type: 'date', required: true, half: true },
          { name: 'isPartialDay', label: 'Part of the day only', type: 'checkbox' },
          { name: 'reason', label: 'Reason', type: 'textarea', required: true },
        ]}
        onSubmit={async (v) => { await api.post('/leave/requests', v); toast.success('Leave request submitted to the class teacher'); qc.invalidateQueries({ queryKey: ['leave'] }); }} />
      {review && <ReviewModal title={`Leave · ${review.studentName}`} detail={`${review.typeName}, ${fmtDate(review.startDate)} – ${fmtDate(review.endDate)}: ${review.reason}`} path={`/leave/requests/${review.id}/review`} onClose={() => setReview(null)} invalidate="leave" />}
    </>
  );
}

function StaffLeave() {
  const { can, context } = useAuth();
  const reviewer = can('leave.review') && can('staff.read');
  const [apply, setApply] = useState(false);
  const [review, setReview] = useState<SLR | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['staff-leave'], queryFn: () => api.get<SLR[]>('/staff/leave/requests') });
  return (
    <>
      <div className="mb-4 flex justify-end">{context?.staffId && <Button onClick={() => setApply(true)}><Plus className="h-4 w-4" />Apply for leave</Button>}</div>
      <Card bodyClass="p-0">
        <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title="No staff leave requests" /> : undefined}>
          <ul className="divide-y divide-slate-100">{q.data?.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1"><div className="text-sm font-medium">{r.staffName}</div><div className="text-xs text-slate-500">{r.leaveType} · {fmtDate(r.startDate)} – {fmtDate(r.endDate)}</div><p className="mt-1 text-sm">{r.reason}</p>{r.reviewNote && <p className="text-sm text-slate-500">Note: {r.reviewNote}</p>}</div>
              <Badge className={statusCls[r.status]}>{r.status}</Badge>
              {reviewer && r.status === 'pending' && r.staffId !== context?.staffId && <Button size="sm" onClick={() => setReview(r)}>Review</Button>}
            </li>))}</ul>
        </QueryState>
      </Card>
      <FormModal open={apply} onClose={() => setApply(false)} title="Apply for staff leave" submitLabel="Submit"
        fields={[{ name: 'leaveType', label: 'Leave type', type: 'select', required: true, options: ['Casual', 'Sick', 'Earned', 'On duty', 'Other'].map((x) => ({ value: x, label: x })) }, { name: 'startDate', label: 'From', type: 'date', required: true, half: true }, { name: 'endDate', label: 'To', type: 'date', required: true, half: true }, { name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
        onSubmit={async (v) => { await api.post('/staff/leave/requests', v); toast.success('Submitted'); qc.invalidateQueries({ queryKey: ['staff-leave'] }); }} />
      {review && <ReviewModal title={`Leave · ${review.staffName}`} detail={`${review.leaveType}, ${fmtDate(review.startDate)} – ${fmtDate(review.endDate)}: ${review.reason}`} path={`/staff/leave/requests/${review.id}/review`} onClose={() => setReview(null)} invalidate="staff-leave" />}
    </>
  );
}

function ReviewModal({ title, detail, path, onClose, invalidate }: { title: string; detail: string; path: string; onClose: () => void; invalidate: string }) {
  const [note, setNote] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({ mutationFn: (decision: string) => api.post(path, { decision, note: note || undefined }), onSuccess: () => { toast.success('Decision recorded and the requester notified'); qc.invalidateQueries({ queryKey: [invalidate] }); onClose(); }, onError: (e) => toast.error(e) });
  return (
    <Modal open onClose={onClose} title={title} footer={<><Button variant="danger" disabled={!note} loading={m.isPending} onClick={() => m.mutate('rejected')}>Reject</Button><Button variant="success" loading={m.isPending} onClick={() => m.mutate('approved')}>Approve</Button></>}>
      <p className="text-sm text-slate-700">{detail}</p>
      <div className="mt-4"><Field label="Note" hint="Required when rejecting."><textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
    </Modal>
  );
}
