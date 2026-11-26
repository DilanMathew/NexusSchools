import { and, eq, gte, inArray, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { attendanceRecords, attendanceSessions } from '../../db/schema/index.js';
import type { AttendanceScope } from '../attendance/scope.js';
import type { AttendanceStatus } from '../../db/schema/attendance.js';

export function sessionScopeFilter(scope: AttendanceScope): SQL | undefined {
  if (scope.all) return undefined;
  return or(
    scope.sectionIds.length ? inArray(attendanceSessions.sectionId, scope.sectionIds) : sql`false`,
    scope.offeringIds.length ? inArray(attendanceSessions.courseOfferingId, scope.offeringIds) : sql`false`,
  );
}

export const countedSessions = (inst: string, from?: string, to?: string) => and(
  eq(attendanceSessions.institutionId, inst), ne(attendanceSessions.status, 'open'), ne(attendanceSessions.status, 'cancelled'),
  from ? gte(attendanceSessions.sessionDate, from) : undefined, to ? lte(attendanceSessions.sessionDate, to) : undefined,
);

/** Status counts grouped by an arbitrary key expression. */
export async function groupedStatusCounts(key: SQL, where: SQL | undefined, joins?: (q: ReturnType<typeof base>) => ReturnType<typeof base>) {
  const q = joins ? joins(base(key)) : base(key);
  const rows = await q.where(where).groupBy(key, attendanceRecords.status);
  const out = new Map<string, Partial<Record<AttendanceStatus, number>>>();
  for (const r of rows) {
    if (r.key === null) continue;
    const m = out.get(String(r.key)) ?? {};
    m[r.status] = r.n;
    out.set(String(r.key), m);
  }
  return out;
}
function base(key: SQL) {
  return db.select({ key: sql<string>`${key}`, status: attendanceRecords.status, n: sql<number>`count(*)::int` })
    .from(attendanceRecords).innerJoin(attendanceSessions, eq(attendanceSessions.id, attendanceRecords.sessionId)).$dynamic();
}
