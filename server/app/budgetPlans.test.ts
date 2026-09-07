import { beforeEach, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
process.env.EASYMONEY_DB_PATH ||= path.join(os.tmpdir(), `easymoney-budget-plans-${process.pid}.sqlite`);
const { initDatabase, getDb } = await import('../database.ts');
const { getBudgetPlans, migrateBudgetPlans, saveBudgetPlans } = await import('./budgetPlans.ts');
const plans = { globalBudgets: { 'year:2026': 24000 }, dreamBudget: { globalBudget: 2000, categoryPercents: { '1': 25 } },
  savedBudgets: [{ id: 'plan-1', name: 'My plan', updatedAt: '2026-09-06', globalBudget: 1800, categoryPercents: { '1': 30 } }] };
beforeEach(() => { initDatabase(); getDb().exec('DELETE FROM budgetPlans'); });
test('browser migration preserves every period and template and never replaces newer database plans', () => {
  const first = migrateBudgetPlans(plans);
  expect(first.plans).toEqual(plans);
  const newer = { ...plans, globalBudgets: { 'year:2026': 30000 } };
  saveBudgetPlans({ plans: newer, revision: first.revision });
  expect(migrateBudgetPlans(plans).plans).toEqual(newer);
  initDatabase();
  expect(getBudgetPlans().plans).toEqual(newer);
});
test('stale saves and invalid allocations leave stored plans unchanged', () => {
  const initial = migrateBudgetPlans(plans);
  expect(() => saveBudgetPlans({ plans, revision: 0 })).toThrow('another window');
  expect(() => saveBudgetPlans({ plans: { ...plans, dreamBudget: { globalBudget: -1, categoryPercents: {} } }, revision: initial.revision })).toThrow();
  expect(getBudgetPlans()).toEqual(initial);
});

test('over-budget dollar allocations retain their full percentage after saving', () => {
  const initial = migrateBudgetPlans(plans);
  const updated = { ...plans, dreamBudget: { globalBudget: 3000, categoryPercents: { rent: 4100 / 3000 * 100 } } };
  saveBudgetPlans({ plans: updated, revision: initial.revision });
  expect(getBudgetPlans().plans.dreamBudget).toEqual(updated.dreamBudget);
});
