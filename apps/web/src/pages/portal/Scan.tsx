import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, Camera, XCircle } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Card, Field, PageHeader, Spinner } from '../../components/ui';

type Result = { kind: 'ok' | 'info' | 'error'; message: string };
declare global { interface Window { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> } } }

export default function ScanPage() {
  const [sp] = useSearchParams();
  const { context, memberships, switchInstitution } = useAuth();
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState('');
  const [camera, setCamera] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sent = useRef(false);

  const submit = async (raw: string) => {
    let token = raw.trim(); let inst: string | null = null;
    try { const u = new URL(raw); token = u.searchParams.get('t') ?? token; inst = u.searchParams.get('i'); } catch { /* bare token */ }
    if (inst && inst !== context?.institutionId && memberships.some((m) => m.institutionId === inst)) await switchInstitution(inst);
    setBusy(true); setResult(null);
    try {
      const r = await api.post<{ status: string; message?: string }>('/attendance/qr/scan', { token });
      const s = r.data.status;
      setResult(s === 'recorded' ? { kind: 'ok', message: 'Attendance recorded. Your teacher will confirm it when they submit the register.' } : s === 'already_recorded' ? { kind: 'info', message: 'You are already recorded for this class.' } : { kind: 'info', message: r.data.message ?? 'Your teacher has already marked you.' });
    } catch (e) { setResult({ kind: 'error', message: (e as ApiError).message }); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    const t = sp.get('t');
    if (t && context && !sent.current) { sent.current = true; submit(window.location.href); }
  }, [sp, context]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!camera) return;
    let stream: MediaStream | null = null; let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream; await videoRef.current.play();
        const det = new window.BarcodeDetector!({ formats: ['qr_code'] });
        const loop = async () => {
          if (stop || !videoRef.current) return;
          const codes = await det.detect(videoRef.current).catch(() => []);
          if (codes[0]) { setCamera(false); submit(codes[0].rawValue); return; }
          requestAnimationFrame(loop);
        };
        loop();
      } catch { setResult({ kind: 'error', message: 'Camera access was blocked. Use your phone camera app to scan the code, or paste the code below.' }); setCamera(false); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [camera]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasDetector = typeof window !== 'undefined' && !!window.BarcodeDetector;
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Scan attendance code" subtitle="Scan the code your teacher is showing. It only works while you are signed in as yourself." />
      <Card>
        {busy && <div className="flex items-center gap-2 text-sm text-slate-600"><Spinner />Recording…</div>}
        {result && (
          <div className={`mb-4 flex items-start gap-2 rounded-lg p-3 text-sm ${result.kind === 'ok' ? 'bg-emerald-50 text-emerald-900' : result.kind === 'info' ? 'bg-sky-50 text-sky-900' : 'bg-red-50 text-red-900'}`}>
            {result.kind === 'error' ? <XCircle className="mt-0.5 h-5 w-5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />}{result.message}
          </div>
        )}
        {camera && <video ref={videoRef} className="mb-4 aspect-square w-full rounded-xl bg-black object-cover" muted playsInline />}
        <div className="space-y-4">
          {hasDetector ? <Button className="w-full" size="lg" onClick={() => setCamera((c) => !c)}><Camera className="h-5 w-5" />{camera ? 'Stop camera' : 'Scan with camera'}</Button>
            : <p className="text-sm text-slate-600">Point your phone's camera app at the code on screen — it opens this page automatically.</p>}
          <form onSubmit={(e) => { e.preventDefault(); if (manual) submit(manual); }} className="space-y-2">
            <Field label="Or paste the code link"><input className="input" value={manual} onChange={(e) => setManual(e.target.value)} /></Field>
            <Button variant="outline" disabled={!manual || busy}>Submit code</Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
