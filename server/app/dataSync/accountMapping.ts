import type { SyncAccountClaim } from './types.ts';

export function syncClaimRequiresExplicitMapping(claim: SyncAccountClaim): boolean {
  return claim.requiresExplicitMapping ?? claim.resolution !== 'connector';
}

export function commonSafeSyncAccountDestination(claims: SyncAccountClaim[]): number | null {
  if (claims.length === 0) return null;
  const accountIds = claims.map(claim => {
    if (
      syncClaimRequiresExplicitMapping(claim) ||
      !claim.resolvedAccountId ||
      claim.resolvedAccountStatus === 'archived' ||
      claim.resolution === 'archived-match' ||
      claim.resolution === 'ambiguous'
    ) {
      return null;
    }
    return claim.resolvedAccountId;
  });
  if (accountIds.some(accountId => accountId === null)) return null;
  const uniqueAccountIds = [...new Set(accountIds as number[])];
  return uniqueAccountIds.length === 1 ? uniqueAccountIds[0]! : null;
}
