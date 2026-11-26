import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, FileUp } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Badge, Button, Card, PageHeader, Stat, useToast } from '../../components/ui';

interface Preview { mode: string; summary: { totalRows: number; valid: number; invalid: number; duplicates: number }; valid?: { row: number; admissionNumber: string; name: string; hasSection: boolean }[]; invalid: { row: number; errors: string[] }[]; duplicates: { row: number; admissionNumber: string; reason: string }[]; imported?: number }

export default function StudentImport() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const run = async (mode: 'preview' | 'commit') => {
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    setBusy(true); setErr(null);
    try {
      const r = await api.upload<Preview>(`/students/import?mode=${mode}`, fd);
      if (mode === 'commit') { toast.success(`${r.data.imported} students imported`); qc.invalidateQueries({ queryKey: ['students'] }); nav('/students'); }
      else setPreview(r.data);
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <div>
      <Link to="/students" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" />Students</Link>
      <PageHeader title="Import students" subtitle="Upload a CSV. Every row is checked first; nothing is saved until you confirm." actions={<Button variant="outline" onClick={() => api.download('/students/import/template', 'student-import-template.csv')}><Download className="h-4 w-4" />Download template</Button>} />
      <Card>
        <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-slate-600">
          <li>Download the template and fill one row per student. <b>class_level</b> and <b>section</b> must match a section in the current academic year (e.g. "Grade 7" and "A").</li>
          <li>Upload and review: invalid rows and duplicates are listed with reasons.</li>
          <li>Import the valid rows. The import is all-or-nothing for the valid rows.</li>
        </ol>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-3 text-sm hover:bg-slate-50"><FileUp className="h-5 w-5 text-slate-400" /><span>{file ? file.name : 'Choose CSV file (max 2 MB, 5000 rows)'}</span><input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} /></label>
          <Button disabled={!file} loading={busy && !preview} onClick={() => run('preview')}>Check file</Button>
        </div>
        {err && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
      </Card>
      {preview && (
        <div className="mt-5 space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Rows" value={preview.summary.totalRows} /><Stat label="Valid" value={preview.summary.valid} tone="good" /><Stat label="Invalid" value={preview.summary.invalid} tone={preview.summary.invalid ? 'bad' : 'default'} /><Stat label="Duplicates" value={preview.summary.duplicates} tone={preview.summary.duplicates ? 'warn' : 'default'} />
          </div>
          {(preview.invalid.length > 0 || preview.duplicates.length > 0) && (
            <Card title="Rows that will be skipped" bodyClass="p-0">
              <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto text-sm">
                {preview.invalid.map((r, i) => <li key={`i${i}`} className="px-4 py-2"><Badge className="bg-red-100 text-red-800">Row {r.row}</Badge> {r.errors.join('; ')}</li>)}
                {preview.duplicates.map((r, i) => <li key={`d${i}`} className="px-4 py-2"><Badge className="bg-amber-100 text-amber-800">Row {r.row}</Badge> {r.admissionNumber}: {r.reason}</li>)}
              </ul>
            </Card>
          )}
          <Card title={`Ready to import (${preview.summary.valid})`} actions={<Button disabled={!preview.summary.valid} loading={busy} onClick={() => run('commit')}>Import {preview.summary.valid} students</Button>} bodyClass="p-0">
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto text-sm">{preview.valid?.map((r) => <li key={r.row} className="flex justify-between px-4 py-2"><span>{r.name} <span className="text-slate-500">· {r.admissionNumber}</span></span>{!r.hasSection && <Badge>No section</Badge>}</li>)}</ul>
          </Card>
        </div>
      )}
    </div>
  );
}
