import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { add, apiAction, update } from '../db/api';
import { queryClient, trpc } from '../api/trpc';
import { subscribeToDataChanges } from '../db/api';
import type { AccountSummary } from '../../server/app/types.ts';

export function useAccounts() {
  const accountsQuery = useQuery(trpc.accounts.list.queryOptions(undefined, {
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

  async function addAccount(account: Record<string, unknown>) {
    return add('accounts', {
      ...account,
      currentBalance: account.currentBalance || 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async function updateAccount(id: number | string, changes: Record<string, unknown>) {
    return update('accounts', id, {
      ...changes,
      updatedAt: new Date().toISOString(),
    });
  }

  async function deleteAccount(id: number | string) {
    return apiAction(`/accounts/${id}/deep`, { method: 'DELETE' });
  }

  async function updateBalance(id: number | string, newBalance: number) {
    return update('accounts', id, {
      currentBalance: newBalance,
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    accounts: accountsQuery.data ?? [],
    addAccount,
    updateAccount,
    deleteAccount,
    updateBalance,
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
    updatedAt: account.updatedAt,
  };
}
