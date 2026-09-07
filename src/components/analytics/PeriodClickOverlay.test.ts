import { expect, test } from 'bun:test';
import { getPeriodClickBands } from './PeriodClickOverlay.tsx';

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
