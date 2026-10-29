import { expect, test } from 'bun:test';
import { getActivePeriodPayload, spendingTrendCategories } from './SpendingTrends.tsx';

const periods = [
  { timeKey: '2024', label: '2024' },
  { timeKey: '2025', label: '2025' },
  { timeKey: '2026', label: '2026' },
];

test('spending trend defaults to total only and compares at most the explicitly chosen category', () => {
  const rows = [
    {
      key: '2026',
      label: '2026',
      expenses: 40,
      categoryAmounts: { Dining: 10, Groceries: 20, Travel: 10 },
    },
  ];
  expect(spendingTrendCategories(rows)).toEqual([]);
  expect(spendingTrendCategories(rows, 'Groceries')).toEqual(['Groceries']);
  expect(spendingTrendCategories(rows, 'missing')).toEqual([]);
});

test('resolves a clicked Spending Trends period from Recharts 3 click state', () => {
  expect(getActivePeriodPayload({ activeTooltipIndex: 1 }, periods)).toBe(periods[1]);
  expect(getActivePeriodPayload({ activeTooltipIndex: '2' }, periods)).toBe(periods[2]);
});

test('ignores chart clicks outside a Spending Trends period', () => {
  expect(getActivePeriodPayload({ activeTooltipIndex: undefined }, periods)).toBeNull();
  expect(getActivePeriodPayload({ activeTooltipIndex: 5 }, periods)).toBeNull();
});
