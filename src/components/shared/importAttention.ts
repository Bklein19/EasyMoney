interface CoverageAccount {
  closed: boolean;
  transactionCoverage: string;
  balanceStatus: string;
}

export function importAttentionMessage(accounts: CoverageAccount[] | undefined, failed = false): string | null {
  if (failed) return 'Unable to check data coverage. Open Import to retry.';
  const count = accounts?.filter(account => !account.closed && (
    account.transactionCoverage === 'unverified' || account.balanceStatus !== 'current'
  )).length ?? 0;
  return count ? `${count} account${count === 1 ? '' : 's'} with unverified coverage or missing or older balances. Open Import for details.` : null;
}
