import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarCheck, ChevronRight, ClipboardList, Clock, GraduationCap, UserCheck, UserX } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { Badge, Button, Card, Empty, PageHeader, PctBar, QueryState, Stat } from '../components/ui';
import { GroupBars, TrendChart } from '../components/charts';
import { BAND_META } from '../lib/types';
import { fmtDate, fmtDateTime, fmtPct, fmtTime, titleCase } from '../lib/format';
import { TodayPanel } from './attendance/TakeAttendance';

interface Overview {
  date: string; range: { from: string; to: string }; policy: { eligibilityThreshold: number; calculationUnit: string; version: number }; scope: string; totalStudents: number;
  today: { marked: number; present: number; absent: number; late: number; onLeave: number; percentage: number | null };
  periodAverage: { percentage: number | null }; trend: { date: string; percentage: number | null; conducted: number }[];
  sections: { sectionId: string; label: string; department: string | null; percentage: number | null }[]; departments: { name: string; percentage: number | null }[];
  pending: { leave: number; corrections: number; submissions: number }; recentActivity: { action: string; createdAt: string; actor: string | null }[];
}

export default function Dashboard() {
  const { can, user, institution, context } = useAuth();
  const isStaffView = can('analytics.read');
  const portal = can('attendance.self.read', 'attendance.child.read') && !can('attendance.take', 'analytics.read');
  return (
    <div>
      <PageHeader title={`Welcome, ${user?.fullName.split(' ')[0]}`} subtitle={institution ? `${institution.name} · ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}` : undefined} />
      {!context && <Empty title="You are not a member of any institution" hint="Ask your institution administrator to invite you, or register a new institution." />}
      {portal && <Empty title="Student & parent portal is in the next build phase" hint="Your attendance is being recorded; the portal screens are not yet released." />}
      {can('attendance.take') && !isStaffView && <TodayPanel compact />}
      {isStaffView && <AdminOverview />}
    </div>
  );
}

function AdminOverview() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['overview'], queryFn: () => api.get<Overview>('/analytics/overview') });
  const risk = useQuery({ queryKey: ['at-risk', 'preview'], queryFn: () => api.get<{ studentId: string; name: string; classLabel: string; percentage: number; band: string; sessionsNeeded: number | null }[]>('/analytics/at-risk?limit=6'), enabled: can('ai.risk.read', 'analytics.read') });
  const d = q.data?.data;
  return (
    <QueryState q={q} rows={6}>
      {d && (
        <div className="space-y-5">
          {d.scope === 'limited' && <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">Figures cover the classes and departments you have access to.</p>}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Active students" value={d.totalStudents.toLocaleString('en-IN')} icon={<GraduationCap className="h-4 w-4" />} />
            <Stat label="Present today" value={d.today.present.toLocaleString('en-IN')} tone="good" hint={d.today.marked ? `of ${d.today.marked} marked` : 'No attendance submitted yet'} icon={<UserCheck className="h-4 w-4" />} />
            <Stat label="Absent today" value={d.today.absent.toLocaleString('en-IN')} tone={d.today.absent ? 'bad' : 'default'} hint={d.today.onLeave ? `${d.today.onLeave} on leave` : undefined} icon={<UserX className="h-4 w-4" />} />
            <Stat label="Late today" value={d.today.late} tone="warn" icon={<Clock className="h-4 w-4" />} />
            <Stat label="Today's attendance" value={fmtPct(d.today.percentage)} tone="brand" hint={`30-day avg ${fmtPct(d.periodAverage.percentage)}`} icon={<CalendarCheck className="h-4 w-4" />} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <PendingTile to="/reports?tab=compliance" label="Attendance submissions pending today" n={d.pending.submissions} />
            <PendingTile to="/leave" label="Leave requests awaiting review" n={d.pending.leave} />
            <PendingTile to="/corrections" label="Correction requests pending" n={d.pending.corrections} />
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Attendance trend — last 30 days" className="lg:col-span-2" actions={<span className="text-xs text-slate-500">Policy v{d.policy.version} · {d.policy.calculationUnit === 'day' ? 'day-based' : 'session-based'}</span>}>
              {d.trend.length ? <TrendChart data={d.trend} threshold={d.policy.eligibilityThreshold} /> : <Empty title="No submitted attendance in this period" />}
            </Card>
            <Card title="Students needing attention" actions={<Link to="/insights" className="text-xs font-medium text-brand-600 hover:underline">View all</Link>} bodyClass="p-0">
              {risk.isLoading ? <div className="p-4 text-sm text-slate-500">Loading…</div> : !risk.data?.data.length ? <Empty title="No students below thresholds" /> : (
                <ul className="divide-y divide-slate-100">
                  {risk.data.data.map((r) => (
                    <li key={r.studentId}><Link to={`/students/${r.studentId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                      <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{r.name}</div><div className="text-xs text-slate-500">{r.classLabel}{r.sessionsNeeded ? ` · needs ${r.sessionsNeeded} sessions` : ''}</div></div>
                      <div className="text-right"><div className="text-sm font-semibold tabular-nums">{fmtPct(r.percentage)}</div><Badge className={BAND_META[r.band].cls}>{BAND_META[r.band].label}</Badge></div>
                    </Link></li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Class / section attendance (30 days)" className="lg:col-span-2">
              {d.sections.length ? <GroupBars data={d.sections.map((s) => ({ label: s.label, percentage: s.percentage }))} threshold={d.policy.eligibilityThreshold} /> : <Empty title="No data" />}
            </Card>
            <div className="space-y-5">
              {d.departments.length > 0 && (
                <Card title="Departments">
                  <ul className="space-y-3">{d.departments.map((x) => <li key={x.name}><div className="mb-1 flex justify-between text-sm"><span className="truncate pr-2">{x.name}</span><span className="font-medium tabular-nums">{fmtPct(x.percentage)}</span></div><PctBar value={x.percentage} threshold={d.policy.eligibilityThreshold} /></li>)}</ul>
                </Card>
              )}
              <Card title="Recent activity" bodyClass="p-0">
                <ul className="divide-y divide-slate-100 text-sm">{d.recentActivity.map((a, i) => <li key={i} className="px-4 py-2"><div className="font-medium text-slate-700">{titleCase(a.action.replace('.', ' · '))}</div><div className="text-xs text-slate-500">{a.actor ?? 'System'} · {fmtDateTime(a.createdAt)}</div></li>)}</ul>
              </Card>
            </div>
          </div>
          <p className="text-xs text-slate-400">Range {fmtDate(d.range.from)} – {fmtDate(d.range.to)}. Only submitted attendance is counted.</p>
        </div>
      )}
    </QueryState>
  );
}

function PendingTile({ to, label, n }: { to: string; label: string; n: number }) {
  return (
    <Link to={to} className="card flex items-center gap-3 p-4 transition hover:border-brand-200 hover:shadow">
      <div className={`rounded-lg p-2 ${n ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'}`}>{n ? <AlertTriangle className="h-5 w-5" /> : <ClipboardList className="h-5 w-5" />}</div>
      <div className="flex-1"><div className="text-xl font-semibold tabular-nums">{n}</div><div className="text-xs text-slate-500">{label}</div></div>
      <ChevronRight className="h-4 w-4 text-slate-400" />
    </Link>
  );
}
void Button;
