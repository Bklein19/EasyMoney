import {
  commonSafeSyncAccountDestination,
} from '../../../server/app/dataSync/accountMapping.ts';
import type { SyncAccountClaim } from '../../../server/app/dataSync/types.ts';

export interface SyncAccountClaimGroup {
  identityKey: string;
  claims: SyncAccountClaim[];
  transactionCount: number;
  balanceCount: number;
  latestBalanceDate: string | null;
  latestBalanceCents: number | null;
}

export interface AccountMappingCandidate {
  name: string;
  last4?: string | null;
  currentBalance: number;
  latestBalanceMonth: string | null;
  currency?: string | null;
}

export function formatAccountMappingCandidate(candidate: AccountMappingCandidate): string {
  const last4 = candidate.last4?.trim();
  const last4Label = last4 ? `ending in ${last4}` : 'last four missing';
  const balanceLabel = candidate.latestBalanceMonth === null
    ? 'no imported balance'
    : `ledger balance ${new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: candidate.currency || 'USD',
      }).format(candidate.currentBalance)}`;
  return `${candidate.name} · ${last4Label} · ${balanceLabel}`;
}

export function groupSyncAccountClaims(claims: SyncAccountClaim[]): SyncAccountClaimGroup[] {
  const groups = new Map<string, SyncAccountClaim[]>();
  for (const claim of claims) {
    const groupedClaims = groups.get(claim.remoteAccountId) ?? [];
    groupedClaims.push(claim);
    groups.set(claim.remoteAccountId, groupedClaims);
  }
  return [...groups].map(([identityKey, groupedClaims]) => {
    const datedBalances = groupedClaims
      .filter(claim => claim.latestBalanceDate && claim.latestBalanceCents !== null && claim.latestBalanceCents !== undefined)
      .sort((left, right) => right.latestBalanceDate!.localeCompare(left.latestBalanceDate!));
    const latestBalanceDate = datedBalances[0]?.latestBalanceDate ?? null;
    const latestBalances = latestBalanceDate === null
      ? []
      : datedBalances.filter(claim => claim.latestBalanceDate === latestBalanceDate);
    const latestBalanceAmounts = new Set(latestBalances.map(claim => claim.latestBalanceCents));
    return {
      identityKey,
      claims: groupedClaims,
      transactionCount: groupedClaims.reduce((sum, claim) => sum + claim.transactionCount, 0),
      balanceCount: groupedClaims.reduce((sum, claim) => sum + claim.balanceCount, 0),
      latestBalanceDate,
      latestBalanceCents: latestBalanceAmounts.size === 1 ? latestBalances[0]!.latestBalanceCents ?? null : null,
    };
  });
}

export function syncAccountGroupAutoDestination(claims: SyncAccountClaim[]): number | null {
  return commonSafeSyncAccountDestination(claims);
}

export function syncAccountGroupClaim(claims: SyncAccountClaim[]): SyncAccountClaim {
  const firstClaim = claims[0];
  if (!firstClaim) throw new Error('A sync account group must contain at least one claim.');
  const knownLast4s = new Set(claims
    .map(claim => claim.last4)
    .filter((last4): last4 is string => Boolean(last4)));
  const last4 = knownLast4s.size === 1 ? [...knownLast4s][0]! : null;
  const withGroupLast4 = (claim: SyncAccountClaim): SyncAccountClaim => ({ ...claim, last4 });

  const autoDestination = syncAccountGroupAutoDestination(claims);
  if (autoDestination !== null) {
    return withGroupLast4(claims.find(claim => claim.resolvedAccountId === autoDestination) ?? firstClaim);
  }

  const archivedMatches = claims.filter(claim =>
    claim.resolution === 'archived-match' && claim.resolvedAccountId !== null
  );
  const archivedAccountIds = new Set(archivedMatches.map(claim => claim.resolvedAccountId));
  if (archivedAccountIds.size === 1) {
    return { ...withGroupLast4(archivedMatches[0]!), requiresExplicitMapping: true };
  }

  const representative = claims.find(claim => claim.resolution !== 'archived-match');
  if (representative) return { ...withGroupLast4(representative), requiresExplicitMapping: true };

  return {
    ...withGroupLast4(firstClaim),
    resolvedAccountId: null,
    resolvedAccountName: null,
    resolvedAccountStatus: null,
    resolution: 'ambiguous',
    requiresExplicitMapping: true,
  };
}
