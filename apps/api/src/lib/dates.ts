/** Today's date (YYYY-MM-DD) in an IANA timezone. */
export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
/** ISO weekday (1=Mon..7=Sun) for a YYYY-MM-DD date. */
export function isoWeekday(d: string): number {
  const day = new Date(`${d}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
export function addDays(d: string, n: number): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
