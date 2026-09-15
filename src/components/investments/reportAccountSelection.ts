export function visibleReportAccounts<T extends { id: number; status?: string }>(accounts: T[]): T[] {
  return accounts.filter(account => account.status !== 'archived');
}

// All includes historical data from archived accounts, without cluttering the picker.
export function expandReportSelection(accounts: { id: number; status?: string }[], selected: Set<number>): Set<number> {
  const visible = visibleReportAccounts(accounts);
  return visible.length > 0 && visible.every(account => selected.has(account.id))
    ? new Set(accounts.map(account => account.id))
    : new Set(selected);
}
