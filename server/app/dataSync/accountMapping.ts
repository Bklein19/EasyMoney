import type { SyncAccountClaim } from './types.ts';

export function syncClaimRequiresExplicitMapping(claim: SyncAccountClaim): boolean {
  return claim.requiresExplicitMapping ?? claim.resolution !== 'connector';
}

export function syncAccountMappingWarning(claim: SyncAccountClaim): string | null {
  if (claim.resolution === 'ambiguous') {
    return `${claim.accountName || 'A source account'} matches multiple local accounts and needs an explicit choice.`;
  }
  if (claim.resolution === 'archived-match') {
    return `${claim.accountName || 'A source account'} matches an archived account and needs an explicit choice.`;
  }
  if (!claim.resolvedAccountId) {
    return `${claim.accountName || 'A newly discovered source account'} needs an account mapping before import.`;
  }
  if (syncClaimRequiresExplicitMapping(claim)) {
    return `${claim.accountName || 'A source account'} needs an explicit account choice before import.`;
  }
  return null;
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
