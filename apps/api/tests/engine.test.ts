import { describe, it, expect } from 'vitest';
import { summarize, sessionsNeeded, maxMissable, band, statusWeight, consecutiveAbsentDays, pctFromCounts, type PolicyInput } from '../src/modules/attendance/engine.js';

const base: PolicyInput = { calculationUnit: 'session', lateWeight: 1, halfDayWeight: 0.5, onDutyCountsAsPresent: true, approvedLeaveHandling: 'exclude', medicalLeaveHandling: 'exclude', excusedHandling: 'exclude', excludeHolidays: true, separateLabAndTheory: false, eligibilityThreshold: 75, warningThreshold: 85 };
const r = (status: any, date = '2026-01-01') => ({ status, date });

describe('attendance engine', () => {
  it('computes session percentage', () => {
    const s = summarize([r('present'), r('present'), r('absent'), r('present')], base);
    expect(s).toMatchObject({ conducted: 4, attended: 3, percentage: 75 });
  });
  it('late weight is configurable', () => {
    expect(summarize([r('late'), r('present')], { ...base, lateWeight: 0.5 }).percentage).toBe(75);
    expect(summarize([r('late'), r('present')], { ...base, lateWeight: 0 }).percentage).toBe(50);
  });
  it('approved leave excluded vs counted', () => {
    const recs = [r('present'), r('on_leave'), r('absent')];
    expect(summarize(recs, base)).toMatchObject({ conducted: 2, percentage: 50, excluded: 1 });
    expect(summarize(recs, { ...base, approvedLeaveHandling: 'present' }).percentage).toBeCloseTo(66.67);
    expect(summarize(recs, { ...base, approvedLeaveHandling: 'absent' }).percentage).toBeCloseTo(33.33);
  });
  it('OD toggles', () => {
    expect(summarize([r('on_duty'), r('absent')], base).percentage).toBe(50);
    expect(summarize([r('on_duty'), r('absent')], { ...base, onDutyCountsAsPresent: false }).percentage).toBe(0);
  });
  it('pending verification and N/A never count', () => {
    expect(statusWeight('pending_verification', base)).toBeNull();
    expect(summarize([r('pending_verification'), r('not_applicable')], base).percentage).toBeNull();
  });
  it('cancelled sessions excluded', () => {
    expect(summarize([{ ...r('absent'), sessionCancelled: true }, r('present')], base).percentage).toBe(100);
  });
  it('day mode collapses sessions on the same date', () => {
    const recs = [r('present', '2026-01-01'), r('absent', '2026-01-01'), r('present', '2026-01-02'), r('present', '2026-01-02')];
    const s = summarize(recs, { ...base, calculationUnit: 'day' });
    expect(s.conducted).toBe(2);
    expect(s.percentage).toBe(75);
  });
  it('half day weight', () => {
    expect(summarize([r('half_day'), r('present')], base).percentage).toBe(75);
  });
  it('sessionsNeeded and maxMissable', () => {
    expect(sessionsNeeded(6, 10, 75)).toBe(6); // (6+6)/(10+6)=0.75
    expect(sessionsNeeded(8, 10, 75)).toBe(0);
    expect(sessionsNeeded(5, 10, 100)).toBeNull();
    expect(maxMissable(9, 10, 75)).toBe(2); // 9/12=0.75
    expect(maxMissable(6, 10, 75)).toBe(0);
    expect(maxMissable(0, 0, 75)).toBe(0);
  });
  it('bands', () => {
    expect(band(90, base)).toBe('eligible');
    expect(band(80, base)).toBe('warning');
    expect(band(74.99, base)).toBe('shortage');
    expect(band(null, base)).toBe('no_data');
  });
  it('consecutive absences by day', () => {
    const recs = ['01', '02', '03'].map((d) => r('absent', `2026-01-${d}`)).concat([r('present', '2025-12-31')]);
    expect(consecutiveAbsentDays(recs)).toEqual({ current: 3, longest: 3 });
    expect(consecutiveAbsentDays([r('absent', '2026-01-01'), r('present', '2026-01-01')]).current).toBe(0);
  });
  it('pctFromCounts matches summarize', () => {
    expect(pctFromCounts({ present: 3, absent: 1, on_leave: 4 }, base)).toMatchObject({ conducted: 4, percentage: 75 });
  });
});
