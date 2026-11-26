import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Bot, Send } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Card } from '../../components/ui';

interface Answer { answer: string; toolCalls: { tool: string; input: unknown; rows: number }[]; data?: unknown }
const EXAMPLES = ['Which students are below 75% attendance?', "Show today's absent students", 'Which department has the lowest attendance this month?', "Which faculty members haven't submitted attendance today?", 'Students absent three or more consecutive days'];

/** Administrative assistant: answers are built only from permission-checked database tools; it cannot write data. */
export function AssistantPanel() {
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => api.get<{ assistant: { available: boolean; reason?: string; mode?: string } }>('/ai/status') });
  const [q, setQ] = useState('');
  const [log, setLog] = useState<{ q: string; a?: Answer; err?: string }[]>([]);
  const ask = useMutation({
    mutationFn: (question: string) => api.post<Answer>('/ai/assistant', { question }),
    onMutate: (question) => setLog((l) => [...l, { q: question }]),
    onSuccess: (r) => setLog((l) => l.map((x, i) => (i === l.length - 1 ? { ...x, a: r.data } : x))),
    onError: (e) => setLog((l) => l.map((x, i) => (i === l.length - 1 ? { ...x, err: (e as Error).message } : x))),
  });
  const s = status.data?.data.assistant;
  if (!s) return null;
  const send = (text: string) => { if (text.trim() && !ask.isPending) { ask.mutate(text.trim()); setQ(''); } };
  return (
    <Card className="mb-5" title={<span className="flex items-center gap-2"><Bot className="h-4 w-4 text-brand-600" />Ask about attendance</span>} actions={<span className="text-xs text-slate-500">{s.mode === 'llm' ? 'AI assistant · reads data you are allowed to see' : 'Built-in question set · AI provider not configured'}</span>}>
      {!s.available ? <p className="text-sm text-slate-500">{s.reason}</p> : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">{EXAMPLES.map((e) => <button key={e} onClick={() => send(e)} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 hover:bg-slate-200">{e}</button>)}</div>
          {log.length > 0 && (
            <div className="mb-3 max-h-96 space-y-3 overflow-y-auto">
              {log.map((m, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-brand-700 px-3 py-2 text-sm text-white">{m.q}</div>
                  {m.err ? <div className="w-fit max-w-[85%] rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-800">{m.err}</div>
                    : !m.a ? <div className="w-fit rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-500">Looking that up…</div>
                    : <div className="w-fit max-w-[95%] rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2 text-sm text-slate-800"><div className="whitespace-pre-wrap">{m.a.answer}</div>
                      {m.a.toolCalls.length > 0 && <div className="mt-1.5 text-[11px] text-slate-500">Data used: {m.a.toolCalls.map((t) => `${t.tool} (${t.rows} rows)`).join(', ')}</div>}</div>}
                </div>
              ))}
            </div>
          )}
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); send(q); }}><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a question about attendance…" maxLength={500} /><Button loading={ask.isPending} aria-label="Ask"><Send className="h-4 w-4" /></Button></form>
        </>
      )}
    </Card>
  );
}
