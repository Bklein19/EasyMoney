import { expect, test } from 'bun:test';
import { budgetAmounts, budgetPercentages } from './budgetAllocation';

test('dollar costs retain cents through saved percentages and monthly total changes', () => {
  const amounts = { rent: 4100, insurance: 300, groceries: 123.45 };
  for (const total of [8000, 9000, 3000]) {
    const categoryPercents = budgetPercentages(amounts, total);
    expect(budgetAmounts({ globalBudget: total, categoryPercents })).toEqual(amounts);
  }
  expect(budgetPercentages(amounts, 8000).rent).toBeCloseTo(51.25);
  expect(budgetPercentages(amounts, 3000).rent).toBeGreaterThan(100);
});

test('costs can be entered before the monthly total without invalid percentages', () => {
  expect(budgetPercentages({ rent: 4100 }, 0)).toEqual({ rent: 0 });
  expect(budgetPercentages({ rent: 4100 }, 10000)).toEqual({ rent: 41 });
});
