import { expect, test } from 'bun:test';

import { syncAccountGroupAutoDestination } from '../../../src/components/import/syncAccountMapping.ts';
import type { SyncAccountClaim } from './types.ts';

function routedClaim(sourceAccountId: number, resolvedAccountId: number): SyncAccountClaim {
  return {
    sourceAccountId,
    remoteAccountId: 'remote:shared',
    institution: 'Example Institution',
    accountName: `Remote account ${sourceAccountId}`,
    accountHolder: null,
    resolvedAccountId,
    resolvedAccountName: `Local account ${resolvedAccountId}`,
    resolvedAccountStatus: 'active',
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
