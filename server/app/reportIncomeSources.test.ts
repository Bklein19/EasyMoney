import { expect, test } from 'bun:test';
import { reportIncomeSources, type ReportIncomeTransaction } from './reportIncomeSources';

const transaction = (changes: Partial<ReportIncomeTransaction>): ReportIncomeTransaction => ({
  month: '2026-01', account_id: 1, account_type: 'checking', amount_cents: 10000,
  description: 'Receipt', category_id: 1, category_name: 'Income', category_type: 'income', ...changes,
});

test('income sources preserve confirmed gifts, including transfer descriptions', () => {
  expect(reportIncomeSources([transaction({ description: 'Online transfer from a relative', category_id: 2, category_name: 'Gifts received' })]))
    .toEqual([{ month: '2026-01', account_id: 1, source: 'category_2', label: 'Gifts received', amount_cents: 10000 }]);
});

test('unresolved family transfers, internal moves, loans, reimbursements and trade proceeds are not gift income', () => {
  expect(reportIncomeSources([
    transaction({ category_type: 'transfer', description: 'Family transfer' }),
    transaction({ category_type: 'internal_transfer' }),
    transaction({ category_type: 'transfer', category_name: 'Loan' }),
    transaction({ category_type: 'expense', category_name: 'Reimbursement' }),
    transaction({ category_type: null, category_id: null, category_name: null, description: 'Gift from family' }),
    transaction({ account_type: 'investment', description: 'Sale proceeds' }),
    transaction({ account_type: 'credit', description: 'Refund' }),
    transaction({ amount_cents: -10000 }),
  ])).toEqual([]);
});

test('payroll splits broad income only with explicit evidence; other income stays separate', () => {
  const rows = reportIncomeSources([
    transaction({ description: 'Example employer payroll' }),
    transaction({ description: 'Example employer payroll', amount_cents: 20000 }),
    transaction({ description: 'Online transfer from family' }),
    transaction({ account_id: 2, description: 'Example employer payroll' }),
    transaction({ month: '2026-02', category_id: 3, category_name: 'Wages' }),
  ]);
  expect(rows).toContainEqual(expect.objectContaining({ account_id: 1, source: 'payroll', amount_cents: 30000 }));
  expect(rows).toContainEqual(expect.objectContaining({ account_id: 1, source: 'other_income', amount_cents: 10000 }));
  expect(rows).toContainEqual(expect.objectContaining({ account_id: 2, source: 'payroll', amount_cents: 10000 }));
  expect(rows).toContainEqual(expect.objectContaining({ month: '2026-02', label: 'Wages' }));
});
