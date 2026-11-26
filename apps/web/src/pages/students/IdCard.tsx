import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, QueryState } from '../../components/ui';

interface Card { institution: { name: string; logoUrl: string | null; primaryColor: string }; student: { name: string; admissionNumber: string; photoUrl: string | null }; enrolment: { section: string; level: string; year: string } | null; qrDataUrl: string }

/** Print-ready ID card (CR80 size). The QR holds an opaque token, never personal data. */
export default function IdCard() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['id-card', id], queryFn: () => api.get<Card>(`/students/${id}/id-card`) });
  const c = q.data?.data;
  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-slate-100 p-8 print:bg-white">
      <QueryState q={q}>
        {c && (
          <>
            <div className="overflow-hidden rounded-xl bg-white shadow-lg print:shadow-none" style={{ width: '85.6mm', height: '54mm' }}>
              <div className="flex items-center gap-2 px-3 py-1.5 text-white" style={{ background: c.institution.primaryColor }}>
                {c.institution.logoUrl && <img src={c.institution.logoUrl} alt="" className="h-5 w-5 rounded bg-white object-contain" />}
                <span className="truncate text-[10px] font-semibold uppercase tracking-wide">{c.institution.name}</span>
              </div>
              <div className="flex gap-2.5 p-2.5">
                <div className="flex h-[26mm] w-[21mm] shrink-0 items-center justify-center overflow-hidden rounded bg-slate-100 text-2xl font-semibold text-slate-400">{c.student.photoUrl ? <img src={c.student.photoUrl} alt="" className="h-full w-full object-cover" /> : c.student.name.slice(0, 1)}</div>
                <div className="min-w-0 flex-1 text-[9px] leading-tight">
                  <div className="text-[12px] font-semibold leading-snug text-slate-900">{c.student.name}</div>
                  <div className="mt-1 text-slate-500">Admission no.</div><div className="font-medium">{c.student.admissionNumber}</div>
                  {c.enrolment && <><div className="mt-1 text-slate-500">Class</div><div className="font-medium">{c.enrolment.level} {c.enrolment.section}</div><div className="mt-1 text-slate-500">Academic year {c.enrolment.year}</div></>}
                </div>
                <img src={c.qrDataUrl} alt="Identity QR" className="h-[22mm] w-[22mm] self-end" />
              </div>
            </div>
            <div className="no-print flex gap-2"><Button onClick={() => window.print()}>Print</Button><Button variant="outline" onClick={() => window.close()}>Close</Button></div>
            <p className="no-print max-w-sm text-center text-xs text-slate-500">If a card is lost, use "Reissue" on the student's profile: the old QR stops working immediately.</p>
          </>
        )}
      </QueryState>
    </div>
  );
}
