import { expect, test } from 'bun:test';
import { getActivePeriodPayload } from './SpendingTrends.tsx';

const periods = [
  { timeKey: '2024', label: '2024' },
  { timeKey: '2025', label: '2025' },
  { timeKey: '2026', label: '2026' },
];

test('resolves a clicked Spending Trends period from Recharts 3 click state', () => {
  expect(getActivePeriodPayload({ activeTooltipIndex: 1 }, periods)).toBe(periods[1]);
  expect(getActivePeriodPayload({ activeTooltipIndex: '2' }, periods)).toBe(periods[2]);
});

test('ignores chart clicks outside a Spending Trends period', () => {
  expect(getActivePeriodPayload({ activeTooltipIndex: undefined }, periods)).toBeNull();
  expect(getActivePeriodPayload({ activeTooltipIndex: 5 }, periods)).toBeNull();
});
