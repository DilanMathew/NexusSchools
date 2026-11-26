import { Router } from 'express';
import { z } from 'zod';
import { and, asc, count, eq, getTableColumns, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgTable, PgColumn } from 'drizzle-orm/pg-core';
import { db, type DbOrTx } from '../db/client.js';
import { parse, paginationSchema, pageMeta, uuidParam } from './http.js';
import { badRequest, notFound } from './errors.js';
import { auditReq } from './audit.js';
import { requirePermission } from '../middleware/auth.js';
import type { Permission } from '../modules/rbac/catalogue.js';

type AnyTable = PgTable & { id: PgColumn; institutionId: PgColumn };

/** Verifies every referenced id belongs to the caller's institution. Prevents cross-tenant references. */
export async function assertOwned(conn: DbOrTx, institutionId: string, refs: [AnyTable, string | null | undefined][]) {
  for (const [table, id] of refs) {
    if (!id) continue;
    const rows = await conn.select({ id: table.id }).from(table as PgTable).where(and(eq(table.id, id), eq(table.institutionId, institutionId)));
    if (!rows.length) throw badRequest(`Referenced record ${id} was not found in this institution`);
  }
}

export interface CrudOptions<T extends AnyTable> {
  table: T;
  entity: string;
  createSchema: z.ZodObject<z.ZodRawShape>;
  updateSchema?: z.ZodObject<z.ZodRawShape>;
  readPermission: Permission[];
  writePermission: Permission[];
  refs?: Record<string, AnyTable>;
  searchColumns?: PgColumn[];
  filters?: Record<string, PgColumn>;
  orderBy?: PgColumn[];
  softDelete?: boolean;
  beforeWrite?: (conn: DbOrTx, institutionId: string, data: Record<string, unknown>, existingId?: string) => Promise<void>;
}

export function tenantCrud<T extends AnyTable>(o: CrudOptions<T>) {
  const r = Router();
  const cols = getTableColumns(o.table) as Record<string, PgColumn>;
  const deletedAt = o.softDelete ? cols.deletedAt : undefined;
  const scope = (inst: string, extra?: SQL) => and(eq(o.table.institutionId, inst), deletedAt ? isNull(deletedAt) : undefined, extra);

  const refPairs = (data: Record<string, unknown>) =>
    Object.entries(o.refs ?? {}).map(([field, t]) => [t, data[field] as string | undefined] as [AnyTable, string | undefined]);

  r.get('/', requirePermission(...o.readPermission), async (req, res) => {
    const filterShape = Object.fromEntries(Object.keys(o.filters ?? {}).map((k) => [k, z.string().max(100).optional()]));
    const p = parse(paginationSchema.extend({ ...filterShape, pageSize: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    const conds: (SQL | undefined)[] = [];
    for (const [k, col] of Object.entries(o.filters ?? {})) {
      const v = (p as Record<string, unknown>)[k] as string | undefined;
      if (v) conds.push(v.includes(',') ? inArray(col, v.split(',')) : eq(col, v));
    }
    if (p.search && o.searchColumns?.length) {
      conds.push(sql`(${sql.join(o.searchColumns.map((c) => sql`${c} ILIKE ${'%' + p.search + '%'}`), sql` OR `)})`);
    }
    const where = scope(req.ctx!.institutionId, and(...conds));
    const [{ total }] = await db.select({ total: count() }).from(o.table as PgTable).where(where);
    const rows = await db.select().from(o.table as PgTable).where(where)
      .orderBy(...(o.orderBy ?? [cols.createdAt]).map((c) => asc(c)))
      .limit(p.pageSize).offset((p.page - 1) * p.pageSize);
    res.json({ data: rows, meta: pageMeta(p, total) });
  });

  r.get('/:id', requirePermission(...o.readPermission), async (req, res) => {
    const id = parse(uuidParam, req.params.id);
    const [row] = await db.select().from(o.table as PgTable).where(scope(req.ctx!.institutionId, eq(o.table.id, id)));
    if (!row) throw notFound(o.entity);
    res.json({ data: row });
  });

  r.post('/', requirePermission(...o.writePermission), async (req, res) => {
    const data = parse(o.createSchema, req.body) as Record<string, unknown>;
    const inst = req.ctx!.institutionId;
    const row = await db.transaction(async (tx) => {
      await assertOwned(tx, inst, refPairs(data));
      await o.beforeWrite?.(tx, inst, data);
      const [created] = (await tx.insert(o.table).values({ ...data, institutionId: inst } as never).returning()) as unknown[];
      await auditReq(tx, req, { action: `${o.entity.toLowerCase().replace(/\s+/g, '_')}.created`, entityType: o.entity, entityId: (created as { id: string }).id, after: created });
      return created;
    });
    res.status(201).json({ data: row });
  });

  r.patch('/:id', requirePermission(...o.writePermission), async (req, res) => {
    const id = parse(uuidParam, req.params.id);
    const data = parse(o.updateSchema ?? o.createSchema.partial(), req.body) as Record<string, unknown>;
    const inst = req.ctx!.institutionId;
    const row = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(o.table as PgTable).where(scope(inst, eq(o.table.id, id)));
      if (!before) throw notFound(o.entity);
      await assertOwned(tx, inst, refPairs(data));
      await o.beforeWrite?.(tx, inst, data, id);
      const [after] = (await tx.update(o.table).set({ ...data, ...(cols.updatedAt ? { updatedAt: new Date() } : {}) } as never).where(scope(inst, eq(o.table.id, id))).returning()) as unknown[];
      await auditReq(tx, req, { action: `${o.entity.toLowerCase().replace(/\s+/g, '_')}.updated`, entityType: o.entity, entityId: id, before, after });
      return after;
    });
    res.json({ data: row });
  });

  r.delete('/:id', requirePermission(...o.writePermission), async (req, res) => {
    const id = parse(uuidParam, req.params.id);
    const inst = req.ctx!.institutionId;
    const [before] = await db.select().from(o.table as PgTable).where(scope(inst, eq(o.table.id, id)));
    if (!before) throw notFound(o.entity);
    if (deletedAt) await db.update(o.table).set({ deletedAt: new Date() } as never).where(eq(o.table.id, id));
    else await db.delete(o.table).where(and(eq(o.table.id, id), eq(o.table.institutionId, inst)));
    await auditReq(db, req, { action: `${o.entity.toLowerCase().replace(/\s+/g, '_')}.deleted`, entityType: o.entity, entityId: id, before });
    res.json({ data: { ok: true } });
  });

  return r;
}
