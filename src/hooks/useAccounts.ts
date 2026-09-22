import { useQuery } from '@tanstack/react-query';
import { queryClient, trpc, trpcClient } from '../api/trpc';
import type { AccountSummary } from '../../server/app/types.ts';

export type AccountMetadataChanges = {
  name?: unknown;
  institution?: unknown;
  type?: unknown;
  currency?: unknown;
  accountHolder?: unknown;
  last4?: unknown;
  freshnessPolicy?: 'regular' | 'on-demand';
};

export type AccountRow = ReturnType<typeof fromAppAccount>;

export function useAccounts(options: { includeArchived?: boolean } = {}) {
  const includeArchived = Boolean(options.includeArchived);
  const accountsQuery = useQuery(trpc.accounts.list.queryOptions({ includeArchived }, {
    select: data => data.accounts.map(fromAppAccount),
  }));

  async function updateAccount(id: number | string, changes: AccountMetadataChanges) {
    const allowed = new Set(['name', 'institution', 'type', 'currency', 'accountHolder', 'last4', 'freshnessPolicy']);
    const unsupported = Object.keys(changes).filter(field => !allowed.has(field));
    if (unsupported.length) {
      throw new Error(`Accounts only support metadata updates: ${unsupported.join(', ')}`);
    }

    const result = await trpcClient.accounts.updateMetadata.mutate({ id, changes });
    await queryClient.invalidateQueries({ queryKey: trpc.accounts.list.queryKey() });
    await queryClient.invalidateQueries({ queryKey: trpc.dataFreshness.report.queryKey() });
    return result;
  }

  async function archiveAccount(id: number | string) {
    const result = await trpcClient.accounts.archive.mutate({ id });
    await queryClient.invalidateQueries({ queryKey: trpc.accounts.list.queryKey() });
    return result;
  }

  async function unarchiveAccount(id: number | string) {
    const result = await trpcClient.accounts.unarchive.mutate({ id });
    await queryClient.invalidateQueries();
    return result;
  }

  return {
    accounts: accountsQuery.data ?? [],
    updateAccount,
    archiveAccount,
    unarchiveAccount,
    isLoading: accountsQuery.isLoading,
    isFetching: accountsQuery.isFetching,
    error: accountsQuery.error,
  };
}

function fromAppAccount(account: AccountSummary) {
  return {
    id: account.id,
    name: account.name,
    institution: account.institution,
    type: account.type,
    currentBalance: account.balance,
    latestBalanceMonth: account.latestBalanceMonth,
    isClosed: account.isClosed,
    reportingClosedOn: account.reportingClosedOn,
    closureBalanceConflict: account.closureBalanceConflict,
    currency: account.currency,
    accountHolder: account.accountHolder,
    last4: account.last4,
    freshnessPolicy: account.freshnessPolicy ?? 'regular',
    status: account.status,
    archivedAt: account.archivedAt,
    updatedAt: account.updatedAt,
    aliases: account.aliases,
  };
}
