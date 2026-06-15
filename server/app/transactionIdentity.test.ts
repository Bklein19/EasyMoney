import { expect, test } from 'bun:test';
import { assignLedgerTransactionIdentities } from './transactionIdentity.ts';

const duplicateTransactions = [
  {
    id: 2,
    accountId: 1,
    date: '2026-06-16',
    amount: -12,
    description: 'Coffee Shop',
    importFileId: 7,
    importRowId: 12,
    sourceRowIndex: 1,
    stableSourceId: 'source-b',
  },
  {
    id: 1,
    accountId: 1,
    date: '2026-06-16',
    amount: -12,
    description: 'Coffee Shop',
    importFileId: 7,
    importRowId: 11,
    sourceRowIndex: 0,
    stableSourceId: 'source-a',
  },
];

test('ledger transaction duplicate occurrence assignment is input-order independent', () => {
  const forward = assignLedgerTransactionIdentities(duplicateTransactions);
  const reversed = assignLedgerTransactionIdentities([...duplicateTransactions].reverse());

  expect(new Map(forward.map(item => [item.transaction.stableSourceId, item.occurrenceIndex]))).toEqual(
    new Map(reversed.map(item => [item.transaction.stableSourceId, item.occurrenceIndex]))
  );
  expect(new Map(forward.map(item => [item.transaction.stableSourceId, item.ledgerTransactionId]))).toEqual(
    new Map(reversed.map(item => [item.transaction.stableSourceId, item.ledgerTransactionId]))
  );
  expect(forward.find(item => item.transaction.stableSourceId === 'source-a')?.occurrenceIndex).toBe(0);
  expect(forward.find(item => item.transaction.stableSourceId === 'source-b')?.occurrenceIndex).toBe(1);
});
