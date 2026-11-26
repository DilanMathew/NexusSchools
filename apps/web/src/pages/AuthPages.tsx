import { useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CheckCircle2, ClipboardCheck, QrCode, ShieldCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api, ApiError } from '../lib/api';
import { Button, Field } from '../components/ui';

function Shell({ children, title, subtitle }: { children: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-brand-800 via-brand-700 to-teal-700 p-10 text-white lg:flex">
        <div className="flex items-center gap-2.5"><img src="/icon.svg" alt="" className="h-9 w-9" /><span className="text-lg font-semibold">NEXUS AttendIQ</span></div>
        <div>
          <h2 className="max-w-md text-3xl font-semibold leading-tight">Every student accounted for. Every attendance record traceable.</h2>
          <ul className="mt-8 space-y-3 text-sm text-brand-100">
            <li className="flex gap-2"><ClipboardCheck className="h-5 w-5 text-teal-300" />Mark a full class in seconds — online or offline</li>
            <li className="flex gap-2"><QrCode className="h-5 w-5 text-teal-300" />Rotating QR attendance with replay protection</li>
            <li className="flex gap-2"><ShieldCheck className="h-5 w-5 text-teal-300" />Institution-isolated data with a full audit trail</li>
          </ul>
        </div>
        <p className="text-xs text-brand-200">Intelligent Attendance & Student Monitoring Platform</p>
      </div>
      <div className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden"><img src="/icon.svg" alt="" className="h-9 w-9" /><span className="text-lg font-semibold text-brand-800">NEXUS AttendIQ</span></div>
          <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

const loginSchema = z.object({ email: z.string().email('Enter a valid email'), password: z.string().min(1, 'Password is required') });
export function LoginPage() {
  const { login, status } = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [err, setErr] = useState<string | null>(null);
  const f = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });
  if (status === 'authenticated') return <Navigate to={sp.get('next') ?? '/dashboard'} replace />;
  const submit = f.handleSubmit(async (v) => {
    setErr(null);
    try { await login(v.email, v.password); nav(sp.get('next') ?? '/dashboard', { replace: true }); } catch (e) { setErr((e as ApiError).message); }
  });
  return (
    <Shell title="Sign in" subtitle="Use the account your institution created for you.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {err && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
        <Field label="Email" error={f.formState.errors.email?.message}><input className="input" type="email" autoComplete="email" {...f.register('email')} /></Field>
        <Field label="Password" error={f.formState.errors.password?.message}><input className="input" type="password" autoComplete="current-password" {...f.register('password')} /></Field>
        <div className="flex justify-end"><Link to="/forgot-password" className="text-sm text-brand-600 hover:underline">Forgot password?</Link></div>
        <Button className="w-full" size="lg" loading={f.formState.isSubmitting}>Sign in</Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">New institution? <Link to="/register" className="font-medium text-brand-600 hover:underline">Register your school or college</Link></p>
      {(import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO === 'true') && (
        <details className="mt-8 rounded-lg border border-violet-200 bg-violet-50 p-3 text-xs text-violet-900">
          <summary className="cursor-pointer font-medium">Demo accounts (development seed data)</summary>
          <p className="mt-2">Password for all: <code>Demo@AttendIQ2026</code></p>
          <ul className="mt-1 space-y-0.5">
            {['admin', 'principal', 'teacher', 'student', 'parent'].map((r) => <li key={r}><button type="button" className="underline" onClick={() => { f.setValue('email', `${r}@abc-school.example`); f.setValue('password', 'Demo@AttendIQ2026'); }}>{r}@abc-school.example</button> · <button type="button" className="underline" onClick={() => { f.setValue('email', `${r}@xyz-college.example`); f.setValue('password', 'Demo@AttendIQ2026'); }}>{r}@xyz-college.example</button></li>)}
            <li><button type="button" className="underline" onClick={() => { f.setValue('email', 'superadmin@attendiq.example'); f.setValue('password', 'Demo@AttendIQ2026'); }}>superadmin@attendiq.example</button></li>
          </ul>
        </details>
      )}
    </Shell>
  );
}

const pw = z.string().min(10, 'At least 10 characters').regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number');
const regSchema = z.object({
  name: z.string().min(3, 'Institution name is required'),
  type: z.enum(['school', 'college', 'university', 'polytechnic', 'coaching', 'other']),
  contactPhone: z.string().optional(),
  address: z.string().optional(),
  fullName: z.string().min(2, 'Your name is required'),
  email: z.string().email('Enter a valid email'),
  password: pw,
  confirm: z.string(),
  agree: z.literal(true, { message: 'Please confirm' }),
}).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

const TYPES = [
  { v: 'school', l: 'School', d: 'Classes, sections, daily register' },
  { v: 'college', l: 'College', d: 'Departments, semesters, subject-wise' },
  { v: 'university', l: 'University', d: 'Faculties, programmes, credits' },
  { v: 'polytechnic', l: 'Polytechnic', d: 'Diploma programmes, labs' },
  { v: 'coaching', l: 'Coaching / training', d: 'Batches and sessions' },
  { v: 'other', l: 'Other', d: 'Configure from scratch' },
] as const;

export function RegisterPage() {
  const { completeAuth } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const f = useForm<z.infer<typeof regSchema>>({ resolver: zodResolver(regSchema), defaultValues: { type: 'school' } });
  const type = f.watch('type');
  const submit = f.handleSubmit(async (v) => {
    setErr(null);
    try {
      const r = await api.post<{ accessToken: string; user: never; memberships: never[]; institutionId: string }>('/auth/register-institution', { institution: { name: v.name, type: v.type, contactPhone: v.contactPhone || undefined, address: v.address || undefined, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, owner: { fullName: v.fullName, email: v.email, password: v.password } });
      await completeAuth(r.data);
      nav('/settings?tab=setup', { replace: true });
    } catch (e) { setErr((e as ApiError).message); }
  });
  const e = f.formState.errors;
  return (
    <Shell title="Register your institution" subtitle="Creates your institution workspace and owner account. You can configure everything afterwards.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {err && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
        <Field label="Institution name" error={e.name?.message}><input className="input" {...f.register('name')} placeholder="e.g. St. Mary's Arts and Science College" /></Field>
        <div>
          <span className="label">Institution type</span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {TYPES.map((t) => (
              <label key={t.v} className={`cursor-pointer rounded-lg border p-2.5 text-sm transition ${type === t.v ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:border-slate-300'}`}>
                <input type="radio" value={t.v} className="sr-only" {...f.register('type')} />
                <span className="flex items-center justify-between font-medium">{t.l}{type === t.v && <CheckCircle2 className="h-4 w-4 text-brand-600" />}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{t.d}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact phone (optional)"><input className="input" {...f.register('contactPhone')} /></Field>
          <Field label="City / address (optional)"><input className="input" {...f.register('address')} /></Field>
        </div>
        <hr className="border-slate-200" />
        <Field label="Your full name" error={e.fullName?.message}><input className="input" autoComplete="name" {...f.register('fullName')} /></Field>
        <Field label="Work email" error={e.email?.message}><input className="input" type="email" autoComplete="email" {...f.register('email')} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Password" error={e.password?.message} hint="10+ characters with letters and numbers"><input className="input" type="password" autoComplete="new-password" {...f.register('password')} /></Field>
          <Field label="Confirm password" error={e.confirm?.message}><input className="input" type="password" autoComplete="new-password" {...f.register('confirm')} /></Field>
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-600"><input type="checkbox" className="mt-1" {...f.register('agree')} /><span>I am authorised to register this institution and will configure consent and data-processing settings appropriately for students and guardians. {e.agree && <span className="text-red-600">({e.agree.message})</span>}</span></label>
        <Button className="w-full" size="lg" loading={f.formState.isSubmitting}>Create institution</Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">Already registered? <Link to="/login" className="font-medium text-brand-600 hover:underline">Sign in</Link></p>
    </Shell>
  );
}

export function ForgotPasswordPage() {
  const [done, setDone] = useState<string | null>(null);
  const f = useForm<{ email: string }>({ resolver: zodResolver(z.object({ email: z.string().email('Enter a valid email') })) });
  return (
    <Shell title="Reset your password" subtitle="We'll send a reset link to your email if an account exists.">
      {done ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{done}</div> : (
        <form className="space-y-4" onSubmit={f.handleSubmit(async (v) => { const r = await api.post<{ message: string }>('/auth/forgot-password', v); setDone(r.data.message); })}>
          <Field label="Email" error={f.formState.errors.email?.message}><input className="input" type="email" {...f.register('email')} /></Field>
          <Button className="w-full" loading={f.formState.isSubmitting}>Send reset link</Button>
          <p className="text-xs text-slate-500">Note: outbound email requires an email provider to be configured for this deployment.</p>
        </form>
      )}
      <p className="mt-6 text-center text-sm"><Link to="/login" className="text-brand-600 hover:underline">Back to sign in</Link></p>
    </Shell>
  );
}

export function ResetPasswordPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const f = useForm<{ password: string }>({ resolver: zodResolver(z.object({ password: pw })) });
  return (
    <Shell title="Choose a new password">
      <form className="space-y-4" onSubmit={f.handleSubmit(async (v) => { try { await api.post('/auth/reset-password', { token: sp.get('token'), newPassword: v.password }); nav('/login'); } catch (e) { setErr((e as Error).message); } })}>
        {err && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
        <Field label="New password" error={f.formState.errors.password?.message}><input className="input" type="password" {...f.register('password')} /></Field>
        <Button className="w-full" loading={f.formState.isSubmitting}>Update password</Button>
      </form>
    </Shell>
  );
}
