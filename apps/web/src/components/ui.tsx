import { createContext, useCallback, useContext, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Inbox, Info, Loader2, Lock, X, XCircle } from 'lucide-react';
import { ApiError } from '../lib/api';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 shadow-sm',
  secondary: 'bg-slate-100 text-slate-800 hover:bg-slate-200',
  ghost: 'text-slate-600 hover:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
  outline: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
};
export function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  return (
    <button {...rest} disabled={disabled || loading} className={clsx('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50', variants[variant], size === 'sm' ? 'px-2.5 py-1.5 text-xs' : size === 'lg' ? 'px-5 py-3 text-base' : 'px-3.5 py-2 text-sm', className)}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', className ?? 'bg-slate-100 text-slate-700')}>{children}</span>;
}

export function Card({ title, actions, children, className, bodyClass }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={clsx('card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(bodyClass ?? 'p-4')}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone = 'default', icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'good' | 'warn' | 'bad' | 'brand'; icon?: ReactNode }) {
  const toneCls = { default: 'text-slate-900', good: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-red-700', brand: 'text-brand-700' }[tone];
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-slate-500">{label}{icon && <span className="text-slate-400">{icon}</span>}</div>
      <div className={clsx('mt-2 text-2xl font-semibold tabular-nums', toneCls)}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={clsx('h-5 w-5 animate-spin text-brand-600', className)} />;
export const Skeleton = ({ className }: { className?: string }) => <div className={clsx('animate-pulse rounded-md bg-slate-200/70', className)} />;

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return <div className="space-y-3 p-2" aria-busy="true">{Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>;
}

export function Empty({ title, hint, action, icon }: { title: string; hint?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <div className="mb-3 rounded-full bg-slate-100 p-3 text-slate-400">{icon ?? <Inbox className="h-6 w-6" />}</div>
      <p className="font-medium text-slate-700">{title}</p>
      {hint && <p className="mt-1 max-w-md text-sm text-slate-500">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const e = error as ApiError;
  if (e?.status === 403) return <Empty icon={<Lock className="h-6 w-6" />} title="You don't have access to this" hint={e.message || 'Ask your institution administrator if you need this permission.'} />;
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <div className="mb-3 rounded-full bg-red-50 p-3 text-red-500"><AlertTriangle className="h-6 w-6" /></div>
      <p className="font-medium text-slate-800">Something went wrong</p>
      <p className="mt-1 text-sm text-slate-500">{e?.message ?? 'Unexpected error'}</p>
      {retry && <Button variant="outline" size="sm" className="mt-4" onClick={retry}>Try again</Button>}
    </div>
  );
}

export function QueryState({ q, children, empty, rows }: { q: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown; data?: unknown }; children: ReactNode; empty?: boolean | ReactNode; rows?: number }) {
  if (q.isLoading) return <LoadingBlock rows={rows} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (empty) return typeof empty === 'boolean' ? <Empty title="Nothing here yet" /> : <>{empty}</>;
  return <>{children}</>;
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label={title}>
      <div className={clsx('flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Confirm({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger, loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean }) {
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button></>}>
      <div className="text-sm text-slate-600">{message}</div>
    </Modal>
  );
}

export function Field({ label, error, children, hint }: { label: string; error?: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="no-print -mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 px-1">
      {tabs.map((t) => (
        <button key={t.key} onClick={() => onChange(t.key)} className={clsx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition', value === t.key ? 'border-brand-700 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}>{t.label}</button>
      ))}
    </div>
  );
}

export function Pagination({ meta, onPage }: { meta?: { page: number; totalPages: number; total: number; pageSize: number }; onPage: (p: number) => void }) {
  if (!meta || meta.totalPages <= 1) return meta ? <div className="px-3 py-2 text-xs text-slate-500">{meta.total} record{meta.total === 1 ? '' : 's'}</div> : null;
  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-sm">
      <span className="text-xs text-slate-500">Page {meta.page} of {meta.totalPages} · {meta.total} records</span>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>Previous</Button>
        <Button size="sm" variant="outline" disabled={meta.page >= meta.totalPages} onClick={() => onPage(meta.page + 1)}>Next</Button>
      </div>
    </div>
  );
}

// ---------- Toasts ----------
type Toast = { id: number; kind: 'success' | 'error' | 'info'; message: string };
const ToastCtx = createContext<{ push: (kind: Toast['kind'], message: string) => void }>({ push: () => {} });
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], message: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, message }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-auto sm:right-4 sm:top-4 sm:items-end" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={clsx('pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg', t.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : t.kind === 'error' ? 'border-red-200 bg-red-50 text-red-900' : 'border-slate-200 bg-white text-slate-800')}>
            {t.kind === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : t.kind === 'error' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  const { push } = useContext(ToastCtx);
  return { success: (m: string) => push('success', m), error: (e: unknown) => push('error', e instanceof Error ? e.message : String(e)), info: (m: string) => push('info', m) };
}

export function Select({ value, onChange, options, placeholder, className, disabled }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder?: string; className?: string; disabled?: boolean }) {
  return (
    <select className={clsx('input', className)} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function PctBar({ value, threshold }: { value: number | null; threshold?: number }) {
  const v = value ?? 0;
  const color = threshold !== undefined && v < threshold ? 'bg-red-500' : threshold !== undefined && v < threshold + 10 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-100" role="meter" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <div className={clsx('h-full rounded-full', color)} style={{ width: `${Math.min(100, v)}%` }} />
      {threshold !== undefined && <div className="absolute top-0 h-full w-0.5 bg-slate-700/60" style={{ left: `${threshold}%` }} />}
    </div>
  );
}
