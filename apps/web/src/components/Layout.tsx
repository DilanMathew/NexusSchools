import { Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Bell, BookOpen, Building2, CalendarClock, CalendarDays, ChartColumn, ChevronDown, ClipboardCheck, ClipboardList, FileText, GraduationCap,
  LayoutDashboard, LogOut, Megaphone, Menu, PanelLeftClose, PanelLeftOpen, Search, Settings, ShieldCheck, Sparkles, UserRound, Users, UsersRound, X, History, WifiOff,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { Spinner } from './ui';
import { pendingCount } from '../lib/offline';

interface NavItem { to: string; label: string; icon: typeof Bell; perms?: string[]; platform?: boolean }
const NAV: { section: string; items: NavItem[] }[] = [
  { section: 'Overview', items: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/my-attendance', label: 'My attendance', icon: ClipboardCheck, perms: ['attendance.self.read', 'attendance.child.read'] },
    { to: '/notifications', label: 'Notifications', icon: Bell },
    { to: '/announcements', label: 'Announcements', icon: Megaphone },
  ] },
  { section: 'Attendance', items: [
    { to: '/attendance', label: 'Take attendance', icon: ClipboardList, perms: ['attendance.take', 'attendance.take.any'] },
    { to: '/attendance/sessions', label: 'Attendance records', icon: History, perms: ['attendance.read', 'attendance.read.department', 'attendance.read.assigned'] },
    { to: '/corrections', label: 'Corrections', icon: FileText, perms: ['attendance.corrections.review', 'attendance.correction.request', 'attendance.child.read'] },
    { to: '/leave', label: 'Leave', icon: CalendarDays, perms: ['leave.request', 'leave.review'] },
    { to: '/timetable', label: 'Timetable', icon: CalendarClock, perms: ['timetable.read', 'timetable.manage'] },
  ] },
  { section: 'People', items: [
    { to: '/students', label: 'Students', icon: GraduationCap, perms: ['students.read'] },
    { to: '/guardians', label: 'Guardians', icon: UsersRound, perms: ['guardians.manage'] },
    { to: '/staff', label: 'Staff', icon: Users, perms: ['staff.read', 'staff.manage'] },
  ] },
  { section: 'Management', items: [
    { to: '/academics', label: 'Academics', icon: BookOpen, perms: ['academic.manage'] },
    { to: '/reports', label: 'Reports', icon: ChartColumn, perms: ['reports.read'] },
    { to: '/insights', label: 'Insights', icon: Sparkles, perms: ['ai.risk.read'] },
    { to: '/settings', label: 'Settings', icon: Settings, perms: ['institution.manage', 'users.manage', 'roles.manage', 'attendance.policy.manage', 'audit.read'] },
    { to: '/platform', label: 'Platform admin', icon: ShieldCheck, platform: true },
  ] },
];

export function Layout() {
  const { user, institution, memberships, can, logout, switchInstitution, context } = useAuth();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('aiq.collapsed') === '1');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => { setMobileOpen(false); setMenu(false); }, [loc.pathname]);
  useEffect(() => { localStorage.setItem('aiq.collapsed', collapsed ? '1' : '0'); }, [collapsed]);
  useEffect(() => { if (institution) document.documentElement.style.setProperty('--inst-color', institution.primaryColor); }, [institution]);

  const unread = useQuery({ queryKey: ['notifications', 'unread'], queryFn: () => api.get<unknown[]>('/notifications?pageSize=1'), enabled: !!context, refetchInterval: 60_000 });
  const unreadCount = (unread.data?.meta?.unread as number | undefined) ?? 0;
  const [offline, setOffline] = useState(!navigator.onLine);
  const [queued, setQueued] = useState(pendingCount());
  useEffect(() => {
    const on = () => setOffline(false); const off = () => setOffline(true); const q = () => setQueued(pendingCount());
    window.addEventListener('online', on); window.addEventListener('offline', off); window.addEventListener('aiq-queue', q);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); window.removeEventListener('aiq-queue', q); };
  }, []);

  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => (i.platform ? user?.platformRole === 'super_admin' : !i.perms || can(...i.perms))) })).filter((g) => g.items.length && (context || g.items.some((i) => i.platform)));
  const roleLabel = memberships.find((m) => m.institutionId === context?.institutionId)?.roles.map((r) => r.name).join(', ');

  const sidebar = (mobile: boolean) => (
    <nav className="flex h-full flex-col">
      <div className={clsx('flex h-16 items-center gap-2.5 border-b border-white/10 px-4', collapsed && !mobile && 'justify-center px-0')}>
        {institution?.logoUrl ? <img src={institution.logoUrl} alt="" className="h-8 w-8 rounded-lg bg-white object-contain" /> : <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-400/90 text-sm font-bold text-brand-900">{(institution?.name ?? 'N').slice(0, 1)}</div>}
        {(!collapsed || mobile) && <div className="min-w-0"><div className="truncate text-sm font-semibold text-white">{institution?.name ?? 'NEXUS AttendIQ'}</div><div className="text-[11px] text-brand-200">NEXUS AttendIQ</div></div>}
        {mobile && <button className="ml-auto rounded p-1 text-brand-100 hover:bg-white/10" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button>}
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {groups.map((g) => (
          <div key={g.section} className="mb-4">
            {(!collapsed || mobile) && <div className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-brand-300">{g.section}</div>}
            {g.items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.to === '/attendance'} title={i.label}
                className={({ isActive }) => clsx('mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition', isActive ? 'bg-white/15 text-white' : 'text-brand-100 hover:bg-white/10 hover:text-white', collapsed && !mobile && 'justify-center px-0')}>
                <i.icon className="h-[18px] w-[18px] shrink-0" />
                {(!collapsed || mobile) && <span className="truncate">{i.label}</span>}
                {(!collapsed || mobile) && i.to === '/notifications' && unreadCount > 0 && <span className="ml-auto rounded-full bg-teal-400 px-1.5 text-[11px] font-semibold text-brand-900">{unreadCount}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </div>
      {!mobile && (
        <button onClick={() => setCollapsed((c) => !c)} className="flex items-center gap-2 border-t border-white/10 px-4 py-3 text-xs text-brand-200 hover:text-white" aria-label="Toggle sidebar">
          {collapsed ? <PanelLeftOpen className="mx-auto h-4 w-4" /> : <><PanelLeftClose className="h-4 w-4" /> Collapse</>}
        </button>
      )}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className={clsx('no-print sticky top-0 hidden h-screen shrink-0 bg-brand-800 transition-all md:block', collapsed ? 'w-16' : 'w-64')}>{sidebar(false)}</aside>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-slate-900/50 md:hidden" onClick={() => setMobileOpen(false)}><aside className="h-full w-72 bg-brand-800" onClick={(e) => e.stopPropagation()}>{sidebar(true)}</aside></div>}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
          <button className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          {can('students.read') && (
            <form className="hidden max-w-sm flex-1 sm:block" onSubmit={(e) => { e.preventDefault(); const q = new FormData(e.currentTarget).get('q'); nav(`/students?search=${encodeURIComponent(String(q ?? ''))}`); }}>
              <div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><input name="q" className="input pl-9" placeholder="Search students by name or admission no." aria-label="Search students" /></div>
            </form>
          )}
          <div className="ml-auto flex items-center gap-2">
            {(offline || queued > 0) && <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800"><WifiOff className="h-3.5 w-3.5" />{offline ? 'Offline' : ''}{queued > 0 ? ` · ${queued} queued` : ''}</span>}
            {institution?.isDemo && <span className="hidden rounded-full bg-violet-100 px-2.5 py-1 text-xs font-medium text-violet-800 sm:inline">Demo data</span>}
            {context && <Link to="/notifications" className="relative rounded-full p-2 text-slate-600 hover:bg-slate-100" aria-label="Notifications"><Bell className="h-5 w-5" />{unreadCount > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500" />}</Link>}
            <div className="relative">
              <button onClick={() => setMenu((m) => !m)} className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 hover:bg-slate-100" aria-haspopup="menu" aria-expanded={menu}>
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">{user?.fullName.slice(0, 1)}</span>
                <span className="hidden text-left sm:block"><span className="block max-w-[160px] truncate text-sm font-medium leading-tight">{user?.fullName}</span><span className="block max-w-[160px] truncate text-[11px] text-slate-500">{roleLabel ?? (user?.platformRole ? 'Platform admin' : '')}</span></span>
                <ChevronDown className="h-4 w-4 text-slate-400" />
              </button>
              {menu && (
                <div className="absolute right-0 mt-2 w-72 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg" role="menu">
                  <div className="border-b border-slate-100 px-4 py-3"><div className="text-sm font-medium">{user?.fullName}</div><div className="truncate text-xs text-slate-500">{user?.email}</div></div>
                  {memberships.length > 1 && (
                    <div className="border-b border-slate-100 py-1">
                      <div className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Switch institution</div>
                      {memberships.map((m) => (
                        <button key={m.institutionId} onClick={() => { switchInstitution(m.institutionId); nav('/dashboard'); }} className={clsx('flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-slate-50', m.institutionId === context?.institutionId && 'font-semibold text-brand-700')}>
                          <Building2 className="h-4 w-4 text-slate-400" /><span className="truncate">{m.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <Link to="/settings?tab=account" className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-slate-50"><UserRound className="h-4 w-4 text-slate-400" />Account & password</Link>
                  <button onClick={() => logout().then(() => nav('/login'))} className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50"><LogOut className="h-4 w-4" />Sign out</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:px-6 sm:py-6">
          <Suspense fallback={<div className="flex justify-center py-20"><Spinner className="h-7 w-7" /></div>}><Outlet /></Suspense>
        </main>
      </div>
    </div>
  );
}
