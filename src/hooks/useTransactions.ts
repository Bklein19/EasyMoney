import { useEffect, useMemo } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { add, apiAction, bulkAdd, remove, subscribeToDataChanges, update } from '../db/api';
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

  const updateAnnotation = useMutation(trpc.transactions.updateAnnotation.mutationOptions({
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

  async function addTransaction(transaction: Record<string, unknown>) {
    return add('transactions', {
      ...transaction,
      createdAt: new Date().toISOString(),
    });
  }

  async function addTransactionsBatch(transactionsToAdd: Array<Record<string, unknown>>) {
    return bulkAdd('transactions', transactionsToAdd.map(t => ({
      ...t,
      createdAt: new Date().toISOString(),
    })));
  }

  async function updateTransaction(id: number | string, changes: Record<string, unknown>) {
    const legacyChanges = { ...changes };
    const categoryIdChanged = Object.hasOwn(legacyChanges, 'categoryId');
    const notesChanged = Object.hasOwn(legacyChanges, 'notes');
    const categoryId = legacyChanges.categoryId as string | number | null | undefined;
    const notes = legacyChanges.notes as string | null | undefined;
    if (categoryIdChanged || notesChanged) {
      delete legacyChanges.categoryId;
      delete legacyChanges.notes;
      await updateAnnotation.mutateAsync({
        id,
        categoryId: categoryIdChanged ? categoryId : undefined,
        notes: notesChanged ? notes : undefined,
      });
    }
    if (!Object.keys(legacyChanges).length) return { ok: true };
    return update('transactions', id, legacyChanges);
  }

  async function deleteTransaction(id: number | string) {
    return remove('transactions', id);
  }

  async function deleteByImportBatch(batchId: number | string) {
    return apiAction(`/transactions/import-batch/${batchId}`, { method: 'DELETE' });
  }

  return {
    transactions,
    addTransaction,
    addTransactionsBatch,
    updateTransaction,
    deleteTransaction,
    deleteByImportBatch,
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
