interface CoverageAccount {
  status: string;
  balanceStatus: string;
}

export function importAttentionMessage(accounts: CoverageAccount[] | undefined, failed = false): string | null {
  if (failed) return 'Unable to check data freshness. Open Import to retry.';
  const count = accounts?.filter(account => account.status !== 'closed' && account.status !== 'on-demand' && (
    account.status !== 'current' || account.balanceStatus !== 'current'
  )).length ?? 0;
  return count ? `${count} account${count === 1 ? '' : 's'} due for an update or missing data. Open Import for details.` : null;
}
