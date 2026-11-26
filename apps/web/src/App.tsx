import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Spinner, Empty } from './components/ui';
import { LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage } from './pages/AuthPages';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const TakeAttendance = lazy(() => import('./pages/attendance/TakeAttendance'));
const SessionMarking = lazy(() => import('./pages/attendance/SessionMarking'));
const SessionsList = lazy(() => import('./pages/attendance/SessionsList'));
const Corrections = lazy(() => import('./pages/attendance/Corrections'));
const MyAttendance = lazy(() => import('./pages/portal/MyAttendance'));
const ScanPage = lazy(() => import('./pages/portal/Scan'));
const Students = lazy(() => import('./pages/students/Students'));
const StudentDetail = lazy(() => import('./pages/students/StudentDetail'));
const StudentImport = lazy(() => import('./pages/students/StudentImport'));
const Guardians = lazy(() => import('./pages/students/Guardians'));
const IdCard = lazy(() => import('./pages/students/IdCard'));
const Staff = lazy(() => import('./pages/staff/Staff'));
const Academics = lazy(() => import('./pages/academic/Academics'));
const Timetable = lazy(() => import('./pages/timetable/Timetable'));
const Leave = lazy(() => import('./pages/leave/Leave'));
const Reports = lazy(() => import('./pages/reports/Reports'));
const Insights = lazy(() => import('./pages/insights/Insights'));
const Announcements = lazy(() => import('./pages/Announcements'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Settings = lazy(() => import('./pages/settings/Settings'));
const Platform = lazy(() => import('./pages/platform/Platform'));

const FullScreenSpinner = () => <div className="flex h-screen items-center justify-center"><Spinner className="h-8 w-8" /></div>;

function Protected({ children }: { children: ReactNode }) {
  const { status, memberships, user } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <FullScreenSpinner />;
  if (status === 'anonymous') return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (!memberships.length && user?.platformRole === 'super_admin' && !loc.pathname.startsWith('/platform')) return <Navigate to="/platform" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/students/:id/id-card" element={<Protected><Suspense fallback={<FullScreenSpinner />}><IdCard /></Suspense></Protected>} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/attendance" element={<TakeAttendance />} />
        <Route path="/attendance/session/:id" element={<SessionMarking />} />
        <Route path="/attendance/sessions" element={<SessionsList />} />
        <Route path="/corrections" element={<Corrections />} />
        <Route path="/my-attendance" element={<MyAttendance />} />
        <Route path="/scan" element={<ScanPage />} />
        <Route path="/students" element={<Students />} />
        <Route path="/students/import" element={<StudentImport />} />
        <Route path="/students/:id" element={<StudentDetail />} />
        <Route path="/guardians" element={<Guardians />} />
        <Route path="/staff" element={<Staff />} />
        <Route path="/academics" element={<Academics />} />
        <Route path="/timetable" element={<Timetable />} />
        <Route path="/leave" element={<Leave />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/insights" element={<Insights />} />
        <Route path="/announcements" element={<Announcements />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/platform" element={<Platform />} />
        <Route path="*" element={<Empty title="Page not found" hint="The page you are looking for does not exist." />} />
      </Route>
    </Routes>
  );
}
