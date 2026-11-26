import type { Request } from 'express';
import type { DbOrTx } from '../db/client.js';
import { auditLogs } from '../db/schema/index.js';

export interface AuditEntry {
  institutionId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

const REDACT = new Set(['passwordHash', 'password', 'medicalNotes', 'tokenHash']);
function redact(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(redact);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, REDACT.has(k) ? '[redacted]' : redact(val)]));
}

export async function audit(db: DbOrTx, e: AuditEntry) {
  await db.insert(auditLogs).values({
    institutionId: e.institutionId ?? null,
    actorUserId: e.actorUserId ?? null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    before: redact(e.before) ?? null,
    after: redact(e.after) ?? null,
    metadata: e.metadata ?? null,
    ipAddress: e.ip ?? null,
  });
}

/** Convenience: audit within the current request's tenant/actor. */
export function auditReq(db: DbOrTx, req: Request, e: Omit<AuditEntry, 'institutionId' | 'actorUserId' | 'ip'>) {
  return audit(db, { ...e, institutionId: req.ctx?.institutionId ?? null, actorUserId: req.auth?.userId ?? null, ip: req.ip ?? null });
}
