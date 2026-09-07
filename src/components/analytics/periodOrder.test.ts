import { expect, test } from 'bun:test';
import { sortAnalyticsPeriodsChronologically } from './periodOrder.ts';

test('sorts analytics chart periods from oldest to newest without mutating report rows', () => {
  const rows = [
    { key: '2026-09', label: 'Sep 2026' },
    { key: '2026-01', label: 'Jan 2026' },
    { key: '2026-05', label: 'May 2026' },
  ];

  expect(sortAnalyticsPeriodsChronologically(rows).map(row => row.key)).toEqual([
    '2026-01',
    '2026-05',
    '2026-09',
  ]);
  expect(rows.map(row => row.key)).toEqual(['2026-09', '2026-01', '2026-05']);
});
