/**
 * Offline attendance queue (localStorage). Items are only removed after the server reports them as
 * applied or conflict; errors stay queued for retry. Nothing is silently discarded.
 */
import { api } from './api';

export interface QueuedItem {
  clientId: string; institutionId: string; kind: string; date: string; courseOfferingId?: string | null; sectionId?: string | null; periodId?: string | null;
  capturedAt: string; records: { studentId: string; status: string; remarks?: string | null }[]; label: string; lastError?: string;
}
const KEY = 'aiq.offline-queue';
export const readQueue = (): QueuedItem[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; } };
const write = (q: QueuedItem[]) => { localStorage.setItem(KEY, JSON.stringify(q)); window.dispatchEvent(new Event('aiq-queue')); };
export const pendingCount = () => readQueue().length;
export function enqueue(item: Omit<QueuedItem, 'clientId' | 'capturedAt'>) {
  const q = readQueue().filter((x) => !(x.institutionId === item.institutionId && x.date === item.date && x.courseOfferingId === item.courseOfferingId && x.sectionId === item.sectionId && x.periodId === item.periodId));
  q.push({ ...item, clientId: crypto.randomUUID(), capturedAt: new Date().toISOString() });
  write(q);
}

export async function flushQueue(institutionId: string) {
  const all = readQueue();
  const mine = all.filter((x) => x.institutionId === institutionId);
  if (!mine.length || !navigator.onLine) return { applied: 0, conflicts: [] as QueuedItem[], errors: 0 };
  const r = await api.post<{ results: { clientId: string; result: 'applied' | 'conflict' | 'error'; message?: string }[] }>('/attendance/sync', { items: mine.map(({ institutionId: _i, label: _l, lastError: _e, ...rest }) => rest) });
  const done = new Set<string>(); const conflicts: QueuedItem[] = []; let errors = 0;
  for (const res of r.data.results) {
    const it = mine.find((m) => m.clientId === res.clientId)!;
    if (res.result === 'applied') done.add(res.clientId);
    else if (res.result === 'conflict') { done.add(res.clientId); conflicts.push({ ...it, lastError: res.message }); }
    else { errors++; it.lastError = res.message; }
  }
  write(all.filter((x) => !done.has(x.clientId)));
  return { applied: [...done].length - conflicts.length, conflicts, errors };
}
