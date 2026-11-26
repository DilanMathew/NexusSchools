/** API client: access token in memory only, refresh token in an httpOnly cookie, tenant in X-Institution-Id. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

let accessToken: string | null = null;
let institutionId: string | null = localStorage.getItem('aiq.institution');
let refreshing: Promise<boolean> | null = null;
let onUnauthenticated: () => void = () => {};

export const auth = {
  setToken: (t: string | null) => { accessToken = t; },
  getToken: () => accessToken,
  setInstitution: (id: string | null) => { institutionId = id; if (id) localStorage.setItem('aiq.institution', id); else localStorage.removeItem('aiq.institution'); },
  getInstitution: () => institutionId,
  onUnauthenticated: (fn: () => void) => { onUnauthenticated = fn; },
};

export async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'attendiq' } })
      .then(async (r) => { if (!r.ok) return false; const j = await r.json(); accessToken = j.data.accessToken; return true; })
      .catch(() => false)
      .finally(() => { setTimeout(() => { refreshing = null; }, 0); });
  }
  return refreshing;
}

type Opts = { method?: string; body?: unknown; tenant?: boolean; form?: FormData; raw?: boolean };

export async function request<T = unknown>(path: string, opts: Opts = {}, retry = true): Promise<T> {
  const tenant = opts.tenant ?? (!path.startsWith('/auth') && !path.startsWith('/platform') && !path.startsWith('/institutions'));
  const url = `/api${tenant ? '/t' : ''}${path}`;
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (institutionId) headers['X-Institution-Id'] = institutionId;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'), headers, credentials: 'include', body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  if (res.status === 401 && retry && !path.startsWith('/auth/login')) {
    if (await refreshSession()) return request<T>(path, opts, false);
    onUnauthenticated();
  }
  if (opts.raw) { if (!res.ok) throw new ApiError(res.status, 'HTTP', res.statusText); return res as unknown as T; }
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'HTTP', json?.error?.message ?? res.statusText, json?.error?.details);
  return json as T;
}

export const api = {
  get: <T = unknown>(p: string, o?: Opts) => request<{ data: T; meta?: Record<string, unknown> }>(p, o),
  post: <T = unknown>(p: string, body?: unknown, o?: Opts) => request<{ data: T; meta?: Record<string, unknown> }>(p, { ...o, method: 'POST', body: body ?? {} }),
  put: <T = unknown>(p: string, body?: unknown) => request<{ data: T }>(p, { method: 'PUT', body: body ?? {} }),
  patch: <T = unknown>(p: string, body?: unknown) => request<{ data: T }>(p, { method: 'PATCH', body: body ?? {} }),
  delete: <T = unknown>(p: string) => request<{ data: T }>(p, { method: 'DELETE' }),
  upload: <T = unknown>(p: string, form: FormData) => request<{ data: T }>(p, { method: 'POST', form }),
  /** Authenticated file download (CSV etc). */
  async download(p: string, filename: string) {
    const res = await request<Response>(p, { raw: true });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
};

export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}
