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

function Protected({ children }: { children: ReactNode }) {
  const { status, memberships, user } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <FullScreenSpinner />;
  if (status === 'anonymous') return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (!memberships.length && user?.platformRole === 'super_admin' && !loc.pathname.startsWith('/platform')) return <Navigate to="/platform" replace />;
  return <>{children}</>;
}

const FullScreenSpinner = () => <div className="flex h-screen items-center justify-center"><Spinner className="h-8 w-8" /></div>;

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/attendance" element={<TakeAttendance />} />
        <Route path="/attendance/session/:id" element={<SessionMarking />} />
        <Route path="/attendance/sessions" element={<SessionsList />} />
        <Route path="/corrections" element={<Corrections />} />
        <Route path="*" element={<Empty title="Page not found" hint="The page you are looking for does not exist." />} />
      </Route>
    </Routes>
  );
}
