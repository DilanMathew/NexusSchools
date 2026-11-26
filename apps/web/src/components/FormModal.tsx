import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import { Button, Field, Modal } from './ui';

export interface FieldDef {
  name: string; label: string;
  type?: 'text' | 'email' | 'password' | 'date' | 'datetime-local' | 'number' | 'time' | 'select' | 'checkbox' | 'textarea' | 'color' | 'multiselect';
  options?: { value: string; label: string }[]; required?: boolean; hint?: string; placeholder?: string; half?: boolean;
}

/** Generic create/edit dialog. Empty optional fields are sent as null (or omitted on create); server validation errors map back to fields. */
export function FormModal({ open, onClose, title, fields, initial, onSubmit, submitLabel = 'Save', wide }: {
  open: boolean; onClose: () => void; title: string; fields: FieldDef[]; initial?: Record<string, unknown>;
  onSubmit: (values: Record<string, unknown>) => Promise<unknown>; submitLabel?: string; wide?: boolean;
}) {
  const [v, setV] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setV(initial ?? {}); setErrors({}); setFormError(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = v[f.name];
      if (f.required && (raw === undefined || raw === '' || raw === null || (Array.isArray(raw) && !raw.length))) errs[f.name] = 'Required';
      if (f.type === 'checkbox') out[f.name] = !!raw;
      else if (f.type === 'number') out[f.name] = raw === '' || raw === undefined || raw === null ? (initial ? null : undefined) : Number(raw);
      else if (raw === '' || raw === undefined) out[f.name] = initial && f.name in initial ? null : undefined;
      else out[f.name] = raw;
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true); setFormError(null);
    try { await onSubmit(Object.fromEntries(Object.entries(out).filter(([, x]) => x !== undefined))); onClose(); }
    catch (err) {
      const ae = err as ApiError;
      if (Array.isArray(ae.details)) {
        const m: Record<string, string> = {};
        for (const d of ae.details as { path: string; message: string }[]) m[d.path.split('.')[0]] = d.message;
        setErrors(m);
      }
      setFormError(ae.message);
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={title} wide={wide} footer={<><Button variant="outline" type="button" onClick={onClose}>Cancel</Button><Button form="form-modal" loading={busy}>{submitLabel}</Button></>}>
      <form id="form-modal" onSubmit={submit} className="grid grid-cols-2 gap-4" noValidate>
        {formError && <div role="alert" className="col-span-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{formError}</div>}
        {fields.map((f) => {
          const val = v[f.name];
          const set = (x: unknown) => setV((p) => ({ ...p, [f.name]: x }));
          const span = f.half ? 'col-span-2 sm:col-span-1' : 'col-span-2';
          if (f.type === 'checkbox') return <label key={f.name} className={`${span} flex items-center gap-2 text-sm`}><input type="checkbox" checked={!!val} onChange={(e) => set(e.target.checked)} />{f.label}</label>;
          return (
            <div key={f.name} className={span}>
              <Field label={f.label + (f.required ? ' *' : '')} error={errors[f.name]} hint={f.hint}>
                {f.type === 'select' ? (
                  <select className="input" value={String(val ?? '')} onChange={(e) => set(e.target.value)}><option value="">{f.placeholder ?? 'Select…'}</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                ) : f.type === 'multiselect' ? (
                  <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">{f.options?.map((o) => { const arr = (val as string[]) ?? []; return <label key={o.value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={arr.includes(o.value)} onChange={(e) => set(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))} />{o.label}</label>; })}</div>
                ) : f.type === 'textarea' ? (
                  <textarea className="input" rows={3} value={String(val ?? '')} onChange={(e) => set(e.target.value)} placeholder={f.placeholder} />
                ) : (
                  <input className="input" type={f.type ?? 'text'} value={String(val ?? '')} onChange={(e) => set(e.target.value)} placeholder={f.placeholder} />
                )}
              </Field>
            </div>
          );
        })}
      </form>
    </Modal>
  );
}
