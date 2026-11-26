import { Router } from 'express';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { registeredDevices, rfidCards, campusEvents, visitorLogs, students, studentEnrolments, sections, classLevels } from '../../db/schema/index.js';
import { parse, paginationSchema, pageMeta, uuidParam, isoDate } from '../../lib/http.js';
import { AppError, badRequest, notFound, unauthorized } from '../../lib/errors.js';
import { auditReq, audit } from '../../lib/audit.js';
import { assertOwned } from '../../lib/tenant-crud.js';
import { requirePermission } from '../../middleware/auth.js';
import { randomToken, sha256 } from '../../lib/security.js';
import { todayIn } from '../../lib/dates.js';
import { zonedToUtc } from '../attendance/service.js';
import { getAdapter, listAdapters } from './adapters.js';
import { env } from '../../config/env.js';

/** Tenant-scoped management of devices, cards, campus events and visitors. */
export const devicesRouter = Router();

devicesRouter.get('/adapters', requirePermission('devices.manage'), (_req, res) => res.json({ data: listAdapters() }));

devicesRouter.get('/', requirePermission('devices.manage', 'campus.read'), async (req, res) => {
  const rows = await db.select({ id: registeredDevices.id, name: registeredDevices.name, kind: registeredDevices.kind, adapter: registeredDevices.adapter, location: registeredDevices.location, purpose: registeredDevices.purpose, isActive: registeredDevices.isActive, lastSeenAt: registeredDevices.lastSeenAt, lastError: registeredDevices.lastError, createdAt: registeredDevices.createdAt,
    events24h: sql<number>`(select count(*)::int from campus_events e where e.device_id = "registered_devices"."id" and e.received_at > now() - interval '24 hours')` })
    .from(registeredDevices).where(eq(registeredDevices.institutionId, req.ctx!.institutionId)).orderBy(asc(registeredDevices.name));
  const now = Date.now();
  res.json({ data: rows.map((d) => ({ ...d, health: !d.isActive ? 'disabled' : !d.lastSeenAt ? 'never_seen' : now - d.lastSeenAt.getTime() < 15 * 60_000 ? 'online' : now - d.lastSeenAt.getTime() < 24 * 3600_000 ? 'stale' : 'offline' })) });
});

const deviceSchema = z.object({ name: z.string().trim().min(2).max(80), kind: z.enum(['rfid_reader', 'nfc_reader', 'qr_gate', 'other']), adapter: z.string().default('generic-json'), location: z.string().max(120).nullable().optional() });

/** Register a device. The device key is shown once; only its hash is kept. */
devicesRouter.post('/', requirePermission('devices.manage'), async (req, res) => {
  const body = parse(deviceSchema, req.body);
  if (!getAdapter(body.adapter)) throw badRequest('Unknown adapter');
  const key = `aiqd_${randomToken(32)}`;
  const [d] = await db.insert(registeredDevices).values({ ...body, institutionId: req.ctx!.institutionId, keyHash: sha256(key) }).returning();
  await auditReq(db, req, { action: 'device.registered', entityType: 'device', entityId: d.id, after: { name: d.name, kind: d.kind } });
  res.status(201).json({ data: { id: d.id, name: d.name, deviceKey: key, ingestUrl: '/api/device/events', note: 'Store this key on the device now. It cannot be shown again.' } });
});

devicesRouter.patch('/:id', requirePermission('devices.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(deviceSchema.partial().extend({ isActive: z.boolean().optional() }), req.body);
  const [d] = await db.update(registeredDevices).set({ ...body, updatedAt: new Date() }).where(and(eq(registeredDevices.id, id), eq(registeredDevices.institutionId, req.ctx!.institutionId))).returning();
  if (!d) throw notFound('Device');
  await auditReq(db, req, { action: 'device.updated', entityType: 'device', entityId: id, after: body });
  res.json({ data: { ok: true } });
});

devicesRouter.post('/:id/rotate-key', requirePermission('devices.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const key = `aiqd_${randomToken(32)}`;
  const [d] = await db.update(registeredDevices).set({ keyHash: sha256(key), updatedAt: new Date() }).where(and(eq(registeredDevices.id, id), eq(registeredDevices.institutionId, req.ctx!.institutionId))).returning();
  if (!d) throw notFound('Device');
  await auditReq(db, req, { action: 'device.key_rotated', entityType: 'device', entityId: id });
  res.json({ data: { deviceKey: key } });
});

// ---- Cards ----
devicesRouter.get('/cards', requirePermission('devices.manage'), async (req, res) => {
  const p = parse(paginationSchema.extend({ studentId: z.string().uuid().optional() }), req.query);
  const where = and(eq(rfidCards.institutionId, req.ctx!.institutionId), p.studentId ? eq(rfidCards.studentId, p.studentId) : undefined, p.search ? sql`(${rfidCards.cardUid} ILIKE ${'%' + p.search + '%'} OR ${students.firstName} || ' ' || ${students.lastName} ILIKE ${'%' + p.search + '%'})` : undefined);
  const [{ total }] = await db.select({ total: count() }).from(rfidCards).innerJoin(students, eq(students.id, rfidCards.studentId)).where(where);
  const rows = await db.select({ id: rfidCards.id, cardUid: rfidCards.cardUid, status: rfidCards.status, issuedAt: rfidCards.issuedAt, studentId: students.id, studentName: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, admissionNumber: students.admissionNumber })
    .from(rfidCards).innerJoin(students, eq(students.id, rfidCards.studentId)).where(where).orderBy(desc(rfidCards.issuedAt)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({ data: rows, meta: pageMeta(p, total) });
});

/** Assign a card. Any previously active card of the student becomes 'replaced'. */
devicesRouter.post('/cards', requirePermission('devices.manage'), async (req, res) => {
  const body = parse(z.object({ studentId: z.string().uuid(), cardUid: z.string().trim().min(4).max(64) }), req.body);
  const inst = req.ctx!.institutionId;
  await assertOwned(db, inst, [[students, body.studentId]]);
  const card = await db.transaction(async (tx) => {
    const [taken] = await tx.select().from(rfidCards).where(and(eq(rfidCards.institutionId, inst), eq(rfidCards.cardUid, body.cardUid), eq(rfidCards.status, 'active')));
    if (taken) throw new AppError(409, 'CARD_IN_USE', 'This card is already assigned to another student. Deactivate it first.');
    await tx.update(rfidCards).set({ status: 'replaced', deactivatedAt: new Date(), updatedAt: new Date() }).where(and(eq(rfidCards.studentId, body.studentId), eq(rfidCards.status, 'active')));
    const [c] = await tx.insert(rfidCards).values({ institutionId: inst, ...body }).returning();
    await auditReq(tx, req, { action: 'card.assigned', entityType: 'rfid_card', entityId: c.id, after: body });
    return c;
  });
  res.status(201).json({ data: card });
});

devicesRouter.post('/cards/:id/status', requirePermission('devices.manage'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const { status } = parse(z.object({ status: z.enum(['lost', 'deactivated']) }), req.body);
  const [c] = await db.update(rfidCards).set({ status, deactivatedAt: new Date(), updatedAt: new Date() }).where(and(eq(rfidCards.id, id), eq(rfidCards.institutionId, req.ctx!.institutionId), eq(rfidCards.status, 'active'))).returning();
  if (!c) throw notFound('Active card');
  await auditReq(db, req, { action: `card.${status}`, entityType: 'rfid_card', entityId: id });
  res.json({ data: c });
});

// ---- Campus presence ----
devicesRouter.get('/campus/events', requirePermission('campus.read', 'attendance.entry'), async (req, res) => {
  const p = parse(paginationSchema.extend({ date: isoDate.optional(), unresolved: z.enum(['true']).optional() }), req.query);
  const inst = req.ctx!.institutionId;
  const date = p.date ?? todayIn(req.ctx!.timezone);
  const from = zonedToUtc(date, '00:00', req.ctx!.timezone); const to = new Date(from.getTime() + 86400_000);
  const where = and(eq(campusEvents.institutionId, inst), gte(campusEvents.occurredAt, from), lte(campusEvents.occurredAt, to), p.unresolved ? sql`${campusEvents.studentId} is null` : undefined);
  const [{ total }] = await db.select({ total: count() }).from(campusEvents).where(where);
  const rows = await db.select({ id: campusEvents.id, direction: campusEvents.direction, source: campusEvents.source, occurredAt: campusEvents.occurredAt, unresolvedIdentifier: campusEvents.unresolvedIdentifier, deviceName: registeredDevices.name, studentId: students.id, studentName: sql<string | null>`${students.firstName} || ' ' || ${students.lastName}`, admissionNumber: students.admissionNumber })
    .from(campusEvents).leftJoin(students, eq(students.id, campusEvents.studentId)).leftJoin(registeredDevices, eq(registeredDevices.id, campusEvents.deviceId))
    .where(where).orderBy(desc(campusEvents.occurredAt)).limit(p.pageSize).offset((p.page - 1) * p.pageSize);
  res.json({ data: rows, meta: { ...pageMeta(p, total), date } });
});

/** Daily campus summary: first in, last out, late arrivals (first in after the threshold). */
devicesRouter.get('/campus/summary', requirePermission('campus.read', 'attendance.entry'), async (req, res) => {
  const q = parse(z.object({ date: isoDate.optional(), lateAfter: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'), earlyBefore: z.string().regex(/^\d{2}:\d{2}$/).default('15:00') }), req.query);
  const tz = req.ctx!.timezone;
  const date = q.date ?? todayIn(tz);
  const from = zonedToUtc(date, '00:00', tz); const to = new Date(from.getTime() + 86400_000);
  const rows = await db.select({ studentId: campusEvents.studentId, firstIn: sql<string | null>`min(${campusEvents.occurredAt}) filter (where ${campusEvents.direction} = 'in')`, lastOut: sql<string | null>`max(${campusEvents.occurredAt}) filter (where ${campusEvents.direction} = 'out')` })
    .from(campusEvents).where(and(eq(campusEvents.institutionId, req.ctx!.institutionId), gte(campusEvents.occurredAt, from), lte(campusEvents.occurredAt, to), sql`${campusEvents.studentId} is not null`)).groupBy(campusEvents.studentId);
  const lateCut = zonedToUtc(date, q.lateAfter, tz); const earlyCut = zonedToUtc(date, q.earlyBefore, tz);
  const ids = rows.map((r) => r.studentId!);
  const meta = ids.length ? await db.select({ id: students.id, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, adm: students.admissionNumber, sec: sections.name, lvl: classLevels.name }).from(students)
    .leftJoin(studentEnrolments, and(eq(studentEnrolments.studentId, students.id), eq(studentEnrolments.isActive, true))).leftJoin(sections, eq(sections.id, studentEnrolments.sectionId)).leftJoin(classLevels, eq(classLevels.id, sections.classLevelId)).where(inArray(students.id, ids)) : [];
  const list = rows.map((r) => { const m = meta.find((x) => x.id === r.studentId); const fi = r.firstIn ? new Date(r.firstIn) : null; const lo = r.lastOut ? new Date(r.lastOut) : null;
    return { studentId: r.studentId, name: m?.name, admissionNumber: m?.adm, classLabel: `${m?.lvl ?? ''} ${m?.sec ?? ''}`.trim(), firstIn: fi, lastOut: lo, late: !!fi && fi > lateCut, earlyDeparture: !!lo && lo < earlyCut, onCampus: !!fi && (!lo || lo < fi) }; });
  res.json({ data: { date, onCampusNow: list.filter((x) => x.onCampus).length, checkedIn: list.filter((x) => x.firstIn).length, late: list.filter((x) => x.late), earlyDepartures: list.filter((x) => x.earlyDeparture), students: list }, meta: { note: 'Campus presence is separate from class attendance; it does not mark anyone present for a class.' } });
});

/** Manual gate entry by an operator (e.g. forgotten card). Identified by admission number or ID-card QR. */
devicesRouter.post('/campus/events', requirePermission('attendance.entry'), async (req, res) => {
  const body = parse(z.object({ identifier: z.string().trim().min(3).max(80), direction: z.enum(['in', 'out']), note: z.string().max(200).optional() }), req.body);
  const inst = req.ctx!.institutionId;
  const ident = body.identifier.replace(/^AIQ-ID:/, '');
  const [s] = await db.select({ id: students.id, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}` }).from(students)
    .where(and(eq(students.institutionId, inst), sql`(${students.admissionNumber} = ${ident} OR ${students.identityToken} = ${ident})`, sql`${students.deletedAt} is null`));
  if (!s) throw notFound('Student with that admission number or ID card');
  const [e] = await db.insert(campusEvents).values({ institutionId: inst, studentId: s.id, direction: body.direction, source: 'manual', occurredAt: new Date(), dedupeKey: `manual:${randomToken(12)}`, recordedByUserId: req.auth!.userId, note: body.note }).returning();
  await auditReq(db, req, { action: 'campus.manual_entry', entityType: 'campus_event', entityId: e.id, after: { studentId: s.id, direction: body.direction } });
  res.status(201).json({ data: { ...e, studentName: s.name } });
});

devicesRouter.get('/visitors', requirePermission('campus.read', 'attendance.entry'), async (req, res) => {
  res.json({ data: await db.select().from(visitorLogs).where(eq(visitorLogs.institutionId, req.ctx!.institutionId)).orderBy(desc(visitorLogs.checkInAt)).limit(100) });
});
devicesRouter.post('/visitors', requirePermission('attendance.entry'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(120), purpose: z.string().trim().min(2).max(200), phone: z.string().max(30).optional() }), req.body);
  const [v] = await db.insert(visitorLogs).values({ ...body, institutionId: req.ctx!.institutionId, recordedByUserId: req.auth!.userId }).returning();
  res.status(201).json({ data: v });
});
devicesRouter.post('/visitors/:id/checkout', requirePermission('attendance.entry'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const [v] = await db.update(visitorLogs).set({ checkOutAt: new Date() }).where(and(eq(visitorLogs.id, id), eq(visitorLogs.institutionId, req.ctx!.institutionId), sql`${visitorLogs.checkOutAt} is null`)).returning();
  if (!v) throw notFound('Visitor');
  res.json({ data: v });
});

/**
 * Device ingest endpoint (no user session): authenticated by X-Device-Key. Idempotent on (device, eventId),
 * so a reader that buffered events offline can resend its whole buffer safely.
 */
export const deviceIngestRouter = Router();
deviceIngestRouter.post('/events', rateLimit({ windowMs: 60_000, limit: env.NODE_ENV === 'test' ? 10_000 : 120, keyGenerator: (req) => req.header('x-device-key') ?? ipKeyGenerator(req.ip ?? ''), standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const key = req.header('x-device-key');
  if (!key) throw unauthorized('X-Device-Key header required');
  const [d] = await db.select().from(registeredDevices).where(eq(registeredDevices.keyHash, sha256(key)));
  if (!d || !d.isActive) throw unauthorized('Unknown or disabled device');
  const adapter = getAdapter(d.adapter)!;
  let events;
  try { events = adapter.parse(req.body); } catch (e) {
    await db.update(registeredDevices).set({ lastSeenAt: new Date(), lastError: 'Payload rejected by adapter' }).where(eq(registeredDevices.id, d.id));
    throw badRequest('Payload does not match the device adapter format', (e as { issues?: unknown }).issues);
  }
  const cardUids = events.filter((e) => e.identifierType === 'card_uid').map((e) => e.identifier);
  const tokens = events.filter((e) => e.identifierType === 'identity_token').map((e) => e.identifier);
  const cards = cardUids.length ? await db.select({ uid: rfidCards.cardUid, studentId: rfidCards.studentId }).from(rfidCards).where(and(eq(rfidCards.institutionId, d.institutionId), eq(rfidCards.status, 'active'), inArray(rfidCards.cardUid, cardUids))) : [];
  const toks = tokens.length ? await db.select({ t: students.identityToken, id: students.id }).from(students).where(and(eq(students.institutionId, d.institutionId), inArray(students.identityToken, tokens))) : [];
  const now = Date.now();
  const rows = events.map((e) => {
    const studentId = e.identifierType === 'card_uid' ? cards.find((c) => c.uid === e.identifier)?.studentId : toks.find((t) => t.t === e.identifier)?.id;
    // Device clocks can drift; clamp future timestamps to receipt time.
    const occurredAt = e.occurredAt.getTime() > now + 5 * 60_000 ? new Date(now) : e.occurredAt;
    return { institutionId: d.institutionId, deviceId: d.id, studentId: studentId ?? null, direction: e.direction, source: d.kind, occurredAt, dedupeKey: `${d.id}:${e.eventId}`, unresolvedIdentifier: studentId ? null : e.identifier.slice(0, 8) + '…' };
  });
  const inserted = await db.insert(campusEvents).values(rows).onConflictDoNothing().returning({ id: campusEvents.id });
  await db.update(registeredDevices).set({ lastSeenAt: new Date(), lastError: null }).where(eq(registeredDevices.id, d.id));
  if (rows.some((r) => !r.studentId)) await audit(db, { institutionId: d.institutionId, action: 'device.unknown_card', entityType: 'device', entityId: d.id, metadata: { count: rows.filter((r) => !r.studentId).length } });
  res.json({ data: { received: events.length, stored: inserted.length, duplicates: events.length - inserted.length, unresolved: rows.filter((r) => !r.studentId).length } });
});
