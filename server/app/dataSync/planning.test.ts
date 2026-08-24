import { describe, expect, test } from 'bun:test';

import { goalWindowForCoverage } from './planning.ts';

describe('data sync planning', () => {
  test('current sync overlaps the latest imported fact', () => {
    expect(goalWindowForCoverage(
      { kind: 'current', overlapDays: 7 },
      { latestFactDate: '2026-08-01', earliestFactDate: '2020-01-01' },
      '2026-08-16',
    )).toEqual({ startDate: '2026-07-25', endDate: '2026-08-16' });
  });

  test('current sync accepts timestamp-shaped source fact dates', () => {
    expect(goalWindowForCoverage(
      { kind: 'current', overlapDays: 7 },
      { latestFactDate: '2026-08-15T07:00:00.000Z', earliestFactDate: '2020-01-01T08:00:00.000Z' },
      '2026-08-17',
    )).toEqual({ startDate: '2026-08-08', endDate: '2026-08-17' });
  });

  test('backfill ends with overlap after the earliest imported fact', () => {
    expect(goalWindowForCoverage(
      { kind: 'backfill', stopAt: '2018-01-01' },
      { latestFactDate: '2026-08-01', earliestFactDate: '2020-01-01' },
      '2026-08-16',
    )).toEqual({ startDate: '2018-01-01', endDate: '2020-01-08' });
  });

  test('explicit ranges pass through unchanged', () => {
    expect(goalWindowForCoverage(
      { kind: 'range', startDate: '2024-01-01', endDate: '2024-12-31' },
      { latestFactDate: null, earliestFactDate: null },
      '2026-08-16',
    )).toEqual({ startDate: '2024-01-01', endDate: '2024-12-31' });
  });

  test('reports malformed source fact dates explicitly', () => {
    expect(() => goalWindowForCoverage(
      { kind: 'current', overlapDays: 7 },
      { latestFactDate: 'not-a-date', earliestFactDate: null },
      '2026-08-17',
    )).toThrow('Invalid source fact date: not-a-date');
  });
});
