import {
  commonSafeSyncAccountDestination,
} from '../../../server/app/dataSync/accountMapping.ts';
import type { SyncAccountClaim } from '../../../server/app/dataSync/types.ts';

export interface SyncAccountClaimGroup {
  identityKey: string;
  claims: SyncAccountClaim[];
  transactionCount: number;
  balanceCount: number;
}

export function groupSyncAccountClaims(claims: SyncAccountClaim[]): SyncAccountClaimGroup[] {
  const groups = new Map<string, SyncAccountClaim[]>();
  for (const claim of claims) {
    const groupedClaims = groups.get(claim.remoteAccountId) ?? [];
    groupedClaims.push(claim);
    groups.set(claim.remoteAccountId, groupedClaims);
  }
  return [...groups].map(([identityKey, groupedClaims]) => ({
    identityKey,
    claims: groupedClaims,
    transactionCount: groupedClaims.reduce((sum, claim) => sum + claim.transactionCount, 0),
    balanceCount: groupedClaims.reduce((sum, claim) => sum + claim.balanceCount, 0),
  }));
}

export function syncAccountGroupAutoDestination(claims: SyncAccountClaim[]): number | null {
  return commonSafeSyncAccountDestination(claims);
}

export function syncAccountGroupClaim(claims: SyncAccountClaim[]): SyncAccountClaim {
  const firstClaim = claims[0];
  if (!firstClaim) throw new Error('A sync account group must contain at least one claim.');

  const autoDestination = syncAccountGroupAutoDestination(claims);
  if (autoDestination !== null) {
    return claims.find(claim => claim.resolvedAccountId === autoDestination) ?? firstClaim;
  }

  const archivedMatches = claims.filter(claim =>
    claim.resolution === 'archived-match' && claim.resolvedAccountId !== null
  );
  const archivedAccountIds = new Set(archivedMatches.map(claim => claim.resolvedAccountId));
  if (archivedAccountIds.size === 1) {
    return { ...archivedMatches[0]!, requiresExplicitMapping: true };
  }

  const representative = claims.find(claim => claim.resolution !== 'archived-match');
  if (representative) return { ...representative, requiresExplicitMapping: true };

  return {
    ...firstClaim,
    resolvedAccountId: null,
    resolvedAccountName: null,
    resolvedAccountStatus: null,
    resolution: 'ambiguous',
    requiresExplicitMapping: true,
  };
}
