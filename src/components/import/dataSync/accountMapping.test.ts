import { expect, test } from 'bun:test';

import type { SyncAccountClaim } from '../../../../server/app/dataSync/types.ts';
import {
  formatAccountMappingCandidate,
  groupSyncAccountClaims,
  syncAccountGroupClaim,
} from '../syncAccountMapping.ts';

function claim(overrides: Partial<SyncAccountClaim> = {}): SyncAccountClaim {
  return {
    sourceAccountId: 1,
    remoteAccountId: 'remote:shared',
    institution: 'Example Institution',
    accountName: 'Example account',
    accountHolder: null,
    last4: null,
    resolvedAccountId: null,
    resolvedAccountName: null,
    resolvedAccountStatus: null,
    resolution: 'unresolved',
    requiresExplicitMapping: true,
    transactionCount: 1,
    balanceCount: 0,
    latestBalanceDate: null,
    latestBalanceCents: null,
    ...overrides,
  };
}

test('formats account candidates with last four and imported-balance state', () => {
  expect(formatAccountMappingCandidate({
    name: 'Brokerage',
    last4: '1234',
    currentBalance: 0,
    latestBalanceMonth: '2026-08-01',
  })).toBe('Brokerage · ending in 1234 · ledger balance $0.00');

  expect(formatAccountMappingCandidate({
    name: 'Savings',
    last4: null,
    currentBalance: 0,
    latestBalanceMonth: null,
  })).toBe('Savings · last four missing · no imported balance');
});

test('groups claims by remote identity and preserves a latest zero downloaded balance', () => {
  const groups = groupSyncAccountClaims([
    claim({
      sourceAccountId: 1,
      transactionCount: 3,
      balanceCount: 1,
      latestBalanceDate: '2026-07-31',
      latestBalanceCents: 12_345,
    }),
    claim({
      sourceAccountId: 2,
      transactionCount: 2,
      balanceCount: 1,
      latestBalanceDate: '2026-08-31',
      latestBalanceCents: 0,
    }),
    claim({
      sourceAccountId: 3,
      remoteAccountId: 'remote:other',
      transactionCount: 4,
    }),
  ]);

  expect(groups).toHaveLength(2);
  expect(groups[0]).toMatchObject({
    identityKey: 'remote:shared',
    transactionCount: 5,
    balanceCount: 2,
    latestBalanceDate: '2026-08-31',
    latestBalanceCents: 0,
  });
});

test('does not choose between conflicting balances on the latest downloaded date', () => {
  const [group] = groupSyncAccountClaims([
    claim({ sourceAccountId: 1, latestBalanceDate: '2026-08-31', latestBalanceCents: 0 }),
    claim({ sourceAccountId: 2, latestBalanceDate: '2026-08-31', latestBalanceCents: 500 }),
    claim({ sourceAccountId: 3, latestBalanceDate: '2026-07-31', latestBalanceCents: 900 }),
  ]);

  expect(group).toMatchObject({
    latestBalanceDate: '2026-08-31',
    latestBalanceCents: null,
  });
});

test('uses the common last four even when the representative file did not expose it', () => {
  const representative = syncAccountGroupClaim([
    claim({ sourceAccountId: 1, last4: null, resolvedAccountId: 10, resolution: 'connector' }),
    claim({ sourceAccountId: 2, last4: '1234', resolvedAccountId: 10, resolution: 'connector' }),
  ]);

  expect(representative.last4).toBe('1234');
});
