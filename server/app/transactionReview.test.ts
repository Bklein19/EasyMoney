import { expect, test } from 'bun:test';
import { buildWorthReviewing, relatedMerchantKey, reviewedTransaction } from './transactionReview';
import type { TransactionListItem } from './types';

function row(id: string, changes: Partial<TransactionListItem> = {}): TransactionListItem {
  return { id: Number(id) || 1, ledgerTransactionId: id, account: { id: 1, name: 'Checking', institution: 'Bank', type: 'checking' },
    category: null, date: '2026-10-01', amount: -20, merchant: 'Coffee Shop', description: 'Coffee Shop',
    originalDescription: 'Raw bank description', originalCategory: null, type: 'expense', transactionKind: 'activity',
    sourceRole: null, status: 'cleared', notes: 'Keep', importBatchId: null, fingerprint: null, createdAt: null, ...changes };
}
const food = { id: 1, name: 'Food', type: 'expense', categoryGroup: null, description: null, color: null, icon: null } as const;

test('related merchant grouping respects account, direction, activity kind and exact bank identifiers', () => {
  const first = row('1');
  expect(relatedMerchantKey(first)).toBe(relatedMerchantKey(row('2', { merchant: 'COFFEE-SHOP' })));
  for (const different of [row('2', { account: { ...first.account!, id: 2 } }), row('2', { amount: 20 }),
    row('2', { transactionKind: 'refund' }), row('2', { merchant: 'Coffee Shop ref123' })]) {
    expect(relatedMerchantKey(first)).not.toBe(relatedMerchantKey(different));
  }
  for (const merchant of ['Venmo', 'Zelle', 'PayPal', 'Check 123', 'Unknown', 'Mobile deposit']) {
    expect(relatedMerchantKey(row('1', { merchant }))).not.toBe(relatedMerchantKey(row('2', { merchant })));
  }
});

test('worth reviewing conserves repeated occurrences, exact cents and includes categorized conflicts', () => {
  const rows = [row('1', { category: food, amount: -20.01 }), row('2', { category: { ...food, id: 2, name: 'Shopping' }, amount: -20.01 }), row('3')];
  const report = buildWorthReviewing(rows);
  expect(report.totalGroups).toBe(1);
  expect(report.groups[0]?.transactions).toHaveLength(3);
  expect(report.groups[0]?.amountCents).toBe(6002);
  expect(report.groups[0]?.reasons.join(' ')).toContain('Categories differ: Food, Shopping');
  expect(report.groups[0]?.reasons.join(' ')).toContain('1 uncategorized transaction');
  expect(buildWorthReviewing([...rows].reverse())).toEqual(report);
});

test('strong movement clues flag expense assignments without inventing destinations or flagging deliberate income taxes', () => {
  const suspicious = row('1', { category: food, description: 'YOU BOUGHT VTSAX (Cash)' });
  expect(buildWorthReviewing([suspicious]).groups[0]?.reasons.join(' ')).toContain('Possible investment');
  expect(buildWorthReviewing([row('2', { category: { ...food, type: 'income', name: 'Income' }, description: 'Tax journaled RSU' })]).groups).toHaveLength(0);
  expect(buildWorthReviewing([row('3', { category: food })]).groups).toHaveLength(0);
  expect(suspicious.category).toEqual(food);
});

test('overview is limited, ranked, deterministic and ignores missing identities and neutral rows', () => {
  const rows = Array.from({ length: 8 }, (_, index) => row(String(index), { merchant: `Merchant ${index}`, amount: -(index + 1) }));
  expect(buildWorthReviewing(rows).groups).toHaveLength(5);
  expect(buildWorthReviewing(rows).totalGroups).toBe(8);
  expect(buildWorthReviewing(rows).groups[0]?.amountCents).toBe(800);
  expect(buildWorthReviewing([row('zero', { amount: 0 }), row('missing', { ledgerTransactionId: null })]).groups).toEqual([]);
});

test('review evidence retains expected categories, facts and stable identity, not notes', () => {
  expect(reviewedTransaction(row('stable', { category: food }))).toEqual({ transactionId: 'stable', expected: {
    accountId: 1, categoryId: 1, amountCents: -2000, date: '2026-10-01', description: 'Coffee Shop',
  } });
  expect(() => reviewedTransaction(row('missing', { ledgerTransactionId: null }))).toThrow();
});
