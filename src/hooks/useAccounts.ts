import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiAction } from '../db/api';
import { queryClient, trpc } from '../api/trpc';
import { subscribeToDataChanges } from '../db/api';
import type { AccountSummary } from '../../server/app/types.ts';

type AccountMetadataChanges = {
  name?: unknown;
  institution?: unknown;
  type?: unknown;
  currency?: unknown;
};

export function useAccounts(options: { includeArchived?: boolean } = {}) {
  const includeArchived = Boolean(options.includeArchived);
  const accountsQuery = useQuery(trpc.accounts.list.queryOptions({ includeArchived }, {
    select: data => data.accounts.map(fromAppAccount),
  }));

  useEffect(() => {
    const unsubscribe = subscribeToDataChanges(() => {
      queryClient.invalidateQueries({ queryKey: trpc.accounts.list.queryKey() });
    });
    return () => {
      unsubscribe();
    };
  }, []);

  async function updateAccount(id: number | string, changes: AccountMetadataChanges) {
    const allowed = new Set(['name', 'institution', 'type', 'currency']);
    const unsupported = Object.keys(changes).filter(field => !allowed.has(field));
    if (unsupported.length) {
      throw new Error(`Accounts only support metadata updates: ${unsupported.join(', ')}`);
    }

    return apiAction(`/app/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
  }

  async function archiveAccount(id: number | string) {
    return apiAction(`/app/accounts/${id}/archive`, { method: 'POST' });
  }

  async function unarchiveAccount(id: number | string) {
    return apiAction(`/app/accounts/${id}/unarchive`, { method: 'POST' });
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
    currency: account.currency,
    status: account.status,
    archivedAt: account.archivedAt,
    updatedAt: account.updatedAt,
  };
}
