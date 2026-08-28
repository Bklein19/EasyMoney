import { expect, test } from 'bun:test';

import {
  groupSyncAccountClaims,
  syncAccountGroupAutoDestination,
  syncAccountGroupClaim,
} from '../../../src/components/import/syncAccountMapping.ts';
import type { SyncAccountClaim } from './types.ts';

function routedClaim(sourceAccountId: number, resolvedAccountId: number | null): SyncAccountClaim {
  return {
    sourceAccountId,
    remoteAccountId: 'remote:shared',
    institution: 'Example Institution',
    accountName: `Remote account ${sourceAccountId}`,
    accountHolder: null,
    resolvedAccountId,
    resolvedAccountName: resolvedAccountId === null ? null : `Local account ${resolvedAccountId}`,
    resolvedAccountStatus: resolvedAccountId === null ? null : 'active',
    resolution: 'connector',
    requiresExplicitMapping: false,
    transactionCount: 1,
    balanceCount: 0,
  };
}

test('sync review only offers auto mapping for one common safe group destination', () => {
  expect(syncAccountGroupAutoDestination([
    routedClaim(1, 10),
    routedClaim(2, 10),
  ])).toBe(10);

  expect(syncAccountGroupAutoDestination([
    routedClaim(1, 10),
    routedClaim(2, 20),
  ])).toBeNull();
});

test('sync review collapses repeated artifact claims into one mapping group per remote identity', () => {
  const claims = [
    { ...routedClaim(1, 10), remoteAccountId: 'remote:brokerage', transactionCount: 33 },
    { ...routedClaim(2, 20), remoteAccountId: 'remote:retirement', transactionCount: 22 },
    { ...routedClaim(3, 10), remoteAccountId: 'remote:brokerage', transactionCount: 12, balanceCount: 1 },
    { ...routedClaim(4, 10), remoteAccountId: 'remote:brokerage', transactionCount: 7, balanceCount: 1 },
    { ...routedClaim(5, 10), remoteAccountId: 'remote:brokerage', transactionCount: 0, balanceCount: 1 },
    { ...routedClaim(6, 10), remoteAccountId: 'remote:brokerage', transactionCount: 12, balanceCount: 1 },
  ];

  expect(groupSyncAccountClaims(claims).map(group => ({
    identityKey: group.identityKey,
    fileCount: group.claims.length,
    transactionCount: group.transactionCount,
    balanceCount: group.balanceCount,
  }))).toEqual([
    { identityKey: 'remote:brokerage', fileCount: 5, transactionCount: 64, balanceCount: 4 },
    { identityKey: 'remote:retirement', fileCount: 1, transactionCount: 22, balanceCount: 0 },
  ]);
});

test('a collapsed mapping group preserves its unique archived destination', () => {
  const unresolved = {
    ...routedClaim(1, null),
    remoteAccountId: 'remote:brokerage',
    resolution: 'unresolved' as const,
    requiresExplicitMapping: true,
  };
  const archived = {
    ...routedClaim(2, 20),
    remoteAccountId: 'remote:brokerage',
    resolvedAccountName: 'Archived brokerage',
    resolvedAccountStatus: 'archived',
    resolution: 'archived-match' as const,
    requiresExplicitMapping: true,
  };

  expect(syncAccountGroupClaim([unresolved, archived])).toMatchObject({
    sourceAccountId: 2,
    resolvedAccountId: 20,
    resolvedAccountName: 'Archived brokerage',
    resolution: 'archived-match',
    requiresExplicitMapping: true,
  });
});

test('a collapsed mapping group does not guess between conflicting archived destinations', () => {
  const first = {
    ...routedClaim(1, 20),
    remoteAccountId: 'remote:brokerage',
    resolvedAccountStatus: 'archived',
    resolution: 'archived-match' as const,
    requiresExplicitMapping: true,
  };
  const second = {
    ...routedClaim(2, 30),
    remoteAccountId: 'remote:brokerage',
    resolvedAccountStatus: 'archived',
    resolution: 'archived-match' as const,
    requiresExplicitMapping: true,
  };

  expect(syncAccountGroupClaim([first, second])).toMatchObject({
    resolvedAccountId: null,
    resolution: 'ambiguous',
    requiresExplicitMapping: true,
  });
});
