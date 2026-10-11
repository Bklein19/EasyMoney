import { expect, test } from 'bun:test';
import { incomeSourceSeries } from './incomeSourceSeries';

test('income overlays aggregate cumulative, monthly, quarterly and yearly amounts for only selected accounts', () => {
  const rows = [
    { account_id: 1, month: '2026-01', source: 'gifts', label: 'Gifts', amount_cents: 10000 },
    { account_id: 1, month: '2026-03', source: 'gifts', label: 'Gifts', amount_cents: 20000 },
    { account_id: 1, month: '2026-04', source: 'gifts', label: 'Gifts', amount_cents: 40000 },
    { account_id: 2, month: '2026-01', source: 'gifts', label: 'Gifts', amount_cents: 90000 },
  ];
  const overlay = incomeSourceSeries(rows, new Set([1]));
  expect(overlay.at('2026-03', true)).toEqual({ income_0: 300 });
  expect(overlay.at('2026-03', false)).toEqual({ income_0: 200 });
  expect(overlay.at('2026 Q1', false)).toEqual({ income_0: 300 });
  expect(overlay.at('2026', false)).toEqual({ income_0: 700 });
  expect(incomeSourceSeries(rows, new Set()).series).toEqual([]);
});

test('many source categories remain bounded without dropping receipts', () => {
  const overlay = incomeSourceSeries(Array.from({ length: 8 }, (_, i) => ({
    account_id: 1, month: '2026-01', source: String(i), label: `Category ${i}`, amount_cents: (i + 1) * 100,
  })), new Set([1]));
  expect(overlay.series).toHaveLength(6);
  expect(Object.values(overlay.at('2026-01', true)).reduce((a, b) => a + b, 0)).toBe(36);
});
