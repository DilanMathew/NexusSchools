import { describe, it, expect } from 'vitest';
import { findConflicts } from '../src/modules/timetable/conflicts.js';
import { makeQrToken, parseQrToken, isFresh } from '../src/modules/attendance/qr-token.js';
import { toCsv } from '../src/modules/reports/csv.js';

describe('timetable conflicts', () => {
  const e = { id: 'e1', dayOfWeek: 1, periodId: 'p1', staffId: 's1', sectionId: 'A', roomId: 'r1', offeringId: 'o1' };
  it('detects faculty, room and section clashes', () => {
    const c = findConflicts({ dayOfWeek: 1, periodId: 'p1', staffId: 's1', sectionId: 'B', roomId: 'r1', offeringId: 'o2' }, [e]);
    expect(c.map((x) => x.kind).sort()).toEqual(['faculty', 'room']);
    expect(findConflicts({ dayOfWeek: 1, periodId: 'p1', staffId: 's2', sectionId: 'A', roomId: null, offeringId: 'o3' }, [e])[0].kind).toBe('section');
  });
  it('ignores different slot, self, and non-overlapping dates', () => {
    expect(findConflicts({ ...e, periodId: 'p2', id: undefined, offeringId: 'o9' }, [e])).toHaveLength(0);
    expect(findConflicts(e, [e])).toHaveLength(0);
    expect(findConflicts({ ...e, id: 'x', offeringId: 'o9', effectiveFrom: '2026-06-01' }, [{ ...e, effectiveTo: '2026-05-31' }])).toHaveLength(0);
  });
});

describe('qr tokens', () => {
  it('round-trips and rejects tampering', () => {
    const { token } = makeQrToken('11111111-1111-1111-1111-111111111111', 15);
    const p = parseQrToken(token);
    expect(p.ok).toBe(true);
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(parseQrToken(tampered).ok).toBe(false);
    expect(parseQrToken('garbage').ok).toBe(false);
  });
  it('expires after one grace window', () => {
    const now = Date.now();
    const { window } = makeQrToken('q', 15, now);
    expect(isFresh(window, 15, now)).toBe(true);
    expect(isFresh(window, 15, now + 15_000)).toBe(true);
    expect(isFresh(window, 15, now + 31_000)).toBe(false);
  });
});

describe('csv', () => {
  it('escapes and blocks formula injection', () => {
    expect(toCsv(['a'], [['=SUM(A1)'], ['x,"y"']])).toBe('a\r\n\'=SUM(A1)\r\n"x,""y"""\r\n');
  });
});
