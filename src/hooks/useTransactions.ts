import { useEffect, useMemo } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { subscribeToDataChanges } from '../db/api';
import { queryClient, trpc } from '../api/trpc';
import type { TransactionListItem } from '../../server/app/types.ts';

interface TransactionFilters {
  accountId?: string | number | null;
  categoryId?: string | number | null;
  startDate?: string | null;
  endDate?: string | null;
  searchQuery?: string | null;
  type?: string | null;
}

type TransactionRow = ReturnType<typeof fromAppTransaction>;
type TransactionAnnotationChanges = {
  categoryId?: string | number | null;
};

const normalizeId = (value: string | number | null | undefined) => {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  return Number.isNaN(numeric) ? value : numeric;
};

export function useTransactions(filters: TransactionFilters = {}) {
  const accountId = normalizeId(filters.accountId);
  const categoryId = normalizeId(filters.categoryId);
  const query = useMemo(() => ({
    accountId,
    categoryId,
    startDate: filters.startDate,
    endDate: filters.endDate,
    search: filters.searchQuery,
  }), [accountId, categoryId, filters.startDate, filters.endDate, filters.searchQuery]);

  const transactionsQuery = useQuery(trpc.transactions.list.queryOptions(query, {
    select: data => data.transactions.map(fromAppTransaction),
  }));

  const categorize = useMutation(trpc.transactions.categorize.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() }),
  }));

  useEffect(() => {
    const unsubscribe = subscribeToDataChanges(() => {
      queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() });
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const transactions = useMemo(() => {
    let result = transactionsQuery.data ?? [];

    if (filters.type === 'income') {
      result = result.filter(t => t.amount > 0);
    } else if (filters.type === 'expense') {
      result = result.filter(t => t.amount < 0);
    }

    return result;
  }, [transactionsQuery.data, filters.type]);

  async function updateTransaction(id: number | string, changes: TransactionAnnotationChanges) {
    const fields = Object.keys(changes);
    const unsupported = fields.filter(field => field !== 'categoryId');
    if (unsupported.length) {
      throw new Error(`Transactions only support categorization updates: ${unsupported.join(', ')}`);
    }

    const categoryIdChanged = Object.hasOwn(changes, 'categoryId');
    if (categoryIdChanged) {
      await categorize.mutateAsync({
        transactionIds: [id],
        categoryId: changes.categoryId,
      });
    }
    return { ok: true, count: categoryIdChanged ? 1 : 0 };
  }

  async function categorizeTransactions(transactionIds: Array<number | string>, categoryId: string | number | null) {
    if (!transactionIds.length) return { ok: true, count: 0 };
    return categorize.mutateAsync({
      transactionIds,
      categoryId,
    });
  }

  return {
    transactions,
    updateTransaction,
    categorizeTransactions,
    isLoading: transactionsQuery.isLoading,
    isFetching: transactionsQuery.isFetching,
    error: transactionsQuery.error,
  };
}

function fromAppTransaction(transaction: TransactionListItem) {
  return {
    id: transaction.id,
    ledgerTransactionId: transaction.ledgerTransactionId,
    accountId: transaction.account?.id ?? null,
    categoryId: transaction.category?.id ?? null,
    date: transaction.date,
    amount: transaction.amount,
    description: transaction.description,
    merchant: transaction.merchant,
    originalDescription: transaction.originalDescription,
    originalCategory: transaction.originalCategory,
    type: transaction.type,
    transactionKind: transaction.transactionKind,
    status: transaction.status,
    notes: transaction.notes,
    importBatchId: transaction.importBatchId,
    fingerprint: transaction.fingerprint,
    createdAt: transaction.createdAt,
  };
}
