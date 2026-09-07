import { expect, test } from 'bun:test';
import { getAnalyticsPeriodRange, getPeriodClickBands } from './PeriodClickOverlay.tsx';

test('creates contiguous click bands around line-chart period centers', () => {
  expect(getPeriodClickBands([100, 200, 300], 80, 240)).toEqual([
    { start: 80, width: 70 },
    { start: 150, width: 100 },
    { start: 250, width: 70 },
  ]);
});

test('uses the full plot for a single period', () => {
  expect(getPeriodClickBands([200], 80, 240)).toEqual([
    { start: 80, width: 240 },
  ]);
});

test('builds an inclusive period range in either drag direction', () => {
  const periods = [
    { timeKey: '2026-01', displayLabel: 'Jan 2026', startDate: '2026-01-01', endDate: '2026-01-31' },
    { timeKey: '2026-02', displayLabel: 'Feb 2026', startDate: '2026-02-01', endDate: '2026-02-28' },
    { timeKey: '2026-03', displayLabel: 'Mar 2026', startDate: '2026-03-01', endDate: '2026-03-31' },
  ];

  expect(getAnalyticsPeriodRange(periods, 2, 0)).toMatchObject({
    startDate: '2026-01-01',
    endDate: '2026-03-31',
    displayLabel: 'Jan 2026 to Mar 2026',
  });
});
