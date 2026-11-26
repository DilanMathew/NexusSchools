import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, auth, refreshSession } from './api';
import type { Membership, TenantContext, User } from './types';

interface AuthState {
  status: 'loading' | 'anonymous' | 'authenticated';
  user: User | null;
  memberships: Membership[];
  context: TenantContext | null;
  institution: Membership | null;
  can: (...perms: string[]) => boolean;
  hasRole: (...keys: string[]) => boolean;
  login: (email: string, password: string) => Promise<void>;
  completeAuth: (data: { accessToken: string; user: User; memberships: Membership[]; institutionId?: string }) => Promise<void>;
  logout: () => Promise<void>;
  switchInstitution: (id: string) => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [context, setContext] = useState<TenantContext | null>(null);

  const loadMe = useCallback(async () => {
    const r = await api.get<{ user: User; memberships: Membership[]; context: TenantContext | null }>('/auth/me');
    let ctx = r.data.context;
    if (!ctx && r.data.memberships.length) {
      // Saved institution no longer valid: fall back to the first membership.
      auth.setInstitution(r.data.memberships[0].institutionId);
      ctx = (await api.get<{ context: TenantContext | null }>('/auth/me')).data.context;
    }
    setUser(r.data.user); setMemberships(r.data.memberships); setContext(ctx); setStatus('authenticated');
  }, []);

  useEffect(() => {
    auth.onUnauthenticated(() => { auth.setToken(null); setStatus('anonymous'); setUser(null); });
    refreshSession().then((ok) => (ok ? loadMe().catch(() => setStatus('anonymous')) : setStatus('anonymous')));
  }, [loadMe]);

  const completeAuth = useCallback(async (d: { accessToken: string; user: User; memberships: Membership[]; institutionId?: string }) => {
    auth.setToken(d.accessToken);
    const saved = auth.getInstitution();
    const pick = d.institutionId ?? (d.memberships.some((m) => m.institutionId === saved) ? saved : d.memberships[0]?.institutionId) ?? null;
    auth.setInstitution(pick);
    qc.clear();
    await loadMe();
  }, [loadMe, qc]);

  const value = useMemo<AuthState>(() => ({
    status, user, memberships, context,
    institution: memberships.find((m) => m.institutionId === context?.institutionId) ?? null,
    can: (...perms) => !!context && perms.some((p) => context.permissions.includes(p)),
    hasRole: (...keys) => !!context && keys.some((k) => context.roleKeys.includes(k)),
    login: async (email, password) => {
      const r = await api.post<{ accessToken: string; user: User; memberships: Membership[] }>('/auth/login', { email, password });
      await completeAuth(r.data);
    },
    completeAuth,
    logout: async () => { await api.post('/auth/logout').catch(() => {}); auth.setToken(null); qc.clear(); setStatus('anonymous'); setUser(null); setContext(null); },
    switchInstitution: async (id) => { auth.setInstitution(id); qc.clear(); await loadMe(); },
    reload: loadMe,
  }), [status, user, memberships, context, completeAuth, loadMe, qc]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}
