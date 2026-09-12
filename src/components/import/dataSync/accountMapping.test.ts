import { expect, test } from 'bun:test';

import type { SyncAccountClaim } from '../../../../server/app/dataSync/types.ts';
import {
  formatAccountMappingCandidate,
  applySyncGroupMappingChoice,
  groupSyncAccountClaims,
  syncAccountAggregateSummary,
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

test('summarizes only connector-verified identities sharing one safe destination', () => {
  const common = { resolution: 'connector' as const, resolvedAccountId: 10,
    resolvedAccountName: '403(b)', resolvedAccountStatus: 'active', requiresExplicitMapping: false };
  const claims = [
    claim({ ...common, remoteAccountId: 'contract-a', transactionCount: 4 }),
    claim({ ...common, sourceAccountId: 2, remoteAccountId: 'contract-b', transactionCount: 10 }),
    claim({ ...common, sourceAccountId: 3, remoteAccountId: 'statement', transactionCount: 2,
      balanceCount: 1, latestBalanceDate: '2026-06-30', latestBalanceCents: 12345 }),
  ];
  expect(syncAccountAggregateSummary(claims)).toMatchObject({
    transactionCount: 16, balanceCount: 1, latestBalanceDate: '2026-06-30', latestBalanceCents: 12345,
  });
  expect(claims.map(item => item.remoteAccountId)).toEqual(['contract-a', 'contract-b', 'statement']);
  expect(syncAccountAggregateSummary([claims[0]!, { ...claims[1]!, resolvedAccountId: 11 }])).toBeNull();
  expect(syncAccountAggregateSummary([claims[0]!, { ...claims[1]!, requiresExplicitMapping: true }])).toBeNull();
  expect(syncAccountAggregateSummary([claims[0]!, { ...claims[1]!, resolution: 'unresolved' }])).toBeNull();
});

test('one group selection updates every source identity and preserves unrelated choices', () => {
  const groups = groupSyncAccountClaims([
    claim({ sourceAccountId: 1, remoteAccountId: 'contract-a' }),
    claim({ sourceAccountId: 2, remoteAccountId: 'contract-b' }),
    claim({ sourceAccountId: 3, remoteAccountId: 'statement' }),
  ]);
  const original = { 'contract-a': 'auto', 'contract-b': 'old-account', statement: 'auto', unrelated: 'keep' };
  const selected = applySyncGroupMappingChoice(original, groups, 'account-20');
  expect(selected).toEqual({ 'contract-a': 'account-20', 'contract-b': 'account-20', statement: 'account-20', unrelated: 'keep' });
  expect(original['contract-b']).toBe('old-account');
  expect(applySyncGroupMappingChoice(selected, groups, 'needs-selection')).toEqual({
    'contract-a': 'needs-selection', 'contract-b': 'needs-selection', statement: 'needs-selection', unrelated: 'keep',
  });
});

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
