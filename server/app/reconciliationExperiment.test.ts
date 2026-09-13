import { expect, test } from 'bun:test';
import { reconcileAccountEvidence, coverageGaps, type ReconciliationInput } from './reconciliationExperiment';
const fixture = (): ReconciliationInput => ({ type: 'checking', start: '2026-01-01', end: '2026-01-31', periods: [{ start: '2026-01-01', end: '2026-01-31' }], balances: [{ date: '2025-12-31', amountCents: 10000, sourceFileId: 1 }, { date: '2026-01-31', amountCents: 8000, sourceFileId: 2 }], transactions: [{ date: '2026-01-10', amountCents: -1000 }, { date: '2026-01-10', amountCents: -1000 }] });
test('two real identical purchases survive arithmetic; opening day is excluded', () => {
  const input = fixture(); input.transactions.push({ date: '2025-12-31', amountCents: 100 });
  expect(reconcileAccountEvidence(input).windows[0]).toMatchObject({ status: 'balanced', residualCents: 0, ledgerNetCents: -2000 });
});
test('missing or duplicated ledger row produces exact residual', () => {
  const input = fixture(); input.transactions.pop();
  expect(reconcileAccountEvidence(input).windows[0]).toMatchObject({ status: 'mismatch', residualCents: -1000 });
});
test('an observed range cannot substitute for declared coverage', () => {
  const input = fixture(); input.periods = [];
  expect(reconcileAccountEvidence(input).windows[0]?.status).toBe('coverage-unverified');
});
test('conflicting balances cannot be resolved by input order', () => {
  const input = fixture(); input.balances.push({ date: '2026-01-31', amountCents: 9000, sourceFileId: 3 });
  expect(reconcileAccountEvidence(input).windows[0]).toMatchObject({ status: 'balance-conflict', residualCents: null });
  input.balances.reverse();
  expect(reconcileAccountEvidence(input).windows[0]?.status).toBe('balance-conflict');
});
test('investment market movement is not a missing cash transaction', () => {
  const input = fixture(); input.type = 'investment';
  expect(reconcileAccountEvidence(input).windows[0]).toMatchObject({ status: 'unsupported-account-type', residualCents: null });
});
test('nested and adjacent coverage does not invent a gap', () => {
  expect(coverageGaps([{ start: '2026-01-01', end: '2026-01-20' }, { start: '2026-01-05', end: '2026-01-10' }, { start: '2026-01-21', end: '2026-01-31' }], '2026-01-01', '2026-01-31')).toEqual([]);
});
test('accounts without balances remain untested, not balanced', () => {
  const input = fixture(); input.balances = [];
  expect(reconcileAccountEvidence(input).windows).toEqual([]);
});
test('credit liability balances use the existing signed ledger convention', () => {
  const input = fixture(); input.type = 'credit';
  input.balances = [{ date: '2025-12-31', amountCents: -10000, sourceFileId: 1 }, { date: '2026-01-31', amountCents: -12000, sourceFileId: 2 }];
  expect(reconcileAccountEvidence(input).windows[0]?.status).toBe('balanced');
});
test('duplicate statement evidence does not double the balance', () => {
  const input = fixture(); input.balances.push({ ...input.balances[1]!, sourceFileId: 3 });
  expect(reconcileAccountEvidence(input).windows[0]?.status).toBe('balanced');
});
test('later balances cannot enter an as-of report', () => {
  const input = fixture(); input.balances.push({ date: '2026-02-28', amountCents: 0, sourceFileId: 3 });
  expect(reconcileAccountEvidence(input).windows).toHaveLength(1);
});
