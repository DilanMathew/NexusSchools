import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Sparkles, TrendingDown } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { BAND_META } from '../../lib/types';
import { Badge, Card, Empty, PageHeader, QueryState } from '../../components/ui';
import { fmtPct } from '../../lib/format';
import { AssistantPanel } from './Assistant';

export default function Insights() {
  const { can } = useAuth();
  const risk = useQuery({ queryKey: ['at-risk', 'full'], queryFn: () => api.get<{ studentId: string; name: string; classLabel: string; percentage: number; band: string; explanation: string }[]>('/analytics/at-risk?limit=100') });
  const drops = useQuery({ queryKey: ['drops'], queryFn: () => api.get<{ studentId: string; name: string; classLabel: string; delta: number; explanation: string; suggestedAction: string }[]>('/ai/insights/attendance-drops') });
  const dq = useQuery({ queryKey: ['data-quality'], queryFn: () => api.get<{ key: string; label: string; count: number }[]>('/ai/insights/data-quality'), enabled: can('students.manage', 'academic.manage') });
  return (
    <div>
      <PageHeader title="Insights" subtitle="Explainable indicators computed from your attendance records. Each one shows the figures behind it. They support follow-up conversations and never trigger automatic penalties." />
      {can('ai.use') && <AssistantPanel />}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" />Below attendance thresholds</span>} bodyClass="p-0">
          <QueryState q={risk} empty={risk.data?.data.length === 0 ? <Empty title="No students below thresholds" /> : undefined}>
            <ul className="max-h-[520px] divide-y divide-slate-100 overflow-y-auto">{risk.data?.data.map((r) => (
              <li key={r.studentId} className="px-4 py-3"><div className="flex items-center justify-between"><Link to={`/students/${r.studentId}`} className="text-sm font-medium hover:text-brand-700">{r.name} <span className="font-normal text-slate-500">· {r.classLabel}</span></Link><span className="flex items-center gap-2 text-sm font-semibold tabular-nums">{fmtPct(r.percentage)}<Badge className={BAND_META[r.band].cls}>{BAND_META[r.band].label}</Badge></span></div><p className="mt-1 text-xs text-slate-500">{r.explanation}</p></li>))}</ul>
          </QueryState>
        </Card>
        <Card title={<span className="flex items-center gap-2"><TrendingDown className="h-4 w-4 text-red-500" />Sudden attendance drops</span>} bodyClass="p-0">
          <QueryState q={drops} empty={drops.data?.data.length === 0 ? <Empty title="No sudden drops detected" hint="Compares the last 14 days with the 28 days before." /> : undefined}>
            <ul className="max-h-[520px] divide-y divide-slate-100 overflow-y-auto">{drops.data?.data.map((r) => (
              <li key={r.studentId} className="px-4 py-3"><div className="flex items-center justify-between"><Link to={`/students/${r.studentId}`} className="text-sm font-medium hover:text-brand-700">{r.name} <span className="font-normal text-slate-500">· {r.classLabel}</span></Link><Badge className="bg-red-100 text-red-800">{r.delta} pts</Badge></div><p className="mt-1 text-xs text-slate-500">{r.explanation} {r.suggestedAction}</p></li>))}</ul>
          </QueryState>
        </Card>
        {can('students.manage', 'academic.manage') && (
          <Card title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-brand-500" />Data quality</span>} className="lg:col-span-2" bodyClass="p-0">
            <QueryState q={dq}><ul className="divide-y divide-slate-100">{dq.data?.data.map((c) => <li key={c.key} className="flex items-center justify-between px-4 py-2.5 text-sm"><span>{c.label}</span>{c.count ? <Badge className="bg-amber-100 text-amber-800">{c.count}</Badge> : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}</li>)}</ul></QueryState>
          </Card>
        )}
      </div>
    </div>
  );
}
