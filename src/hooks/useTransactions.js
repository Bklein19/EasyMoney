import { useMemo } from 'react';
import { add, apiAction, bulkAdd, remove, update } from '../db/api';
import { useApiTable } from './useApiTable';

const normalizeId = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  return Number.isNaN(numeric) ? value : numeric;
};

export function useTransactions(filters = {}) {
  const accountId = normalizeId(filters.accountId);
  const categoryId = normalizeId(filters.categoryId);
  const allTransactions = useApiTable('transactions', accountId ? { accountId } : {}, [accountId]);

  const transactions = useMemo(() => {
    let result = allTransactions;

    if (filters.startDate) result = result.filter(t => t.date >= filters.startDate);
    if (filters.endDate) result = result.filter(t => t.date <= filters.endDate);
    if (categoryId) result = result.filter(t => t.categoryId === categoryId);
    if (filters.searchQuery) {
      const q = filters.searchQuery.toLowerCase();
      result = result.filter(t =>
        t.merchant?.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q) ||
        t.notes?.toLowerCase().includes(q)
      );
    }
    if (filters.type === 'income') {
      result = result.filter(t => t.amount > 0);
    } else if (filters.type === 'expense') {
      result = result.filter(t => t.amount < 0);
    }

    return result;
  }, [allTransactions, filters.startDate, filters.endDate, categoryId, filters.searchQuery, filters.type]);

  async function addTransaction(transaction) {
    return add('transactions', {
      ...transaction,
      createdAt: new Date().toISOString(),
    });
  }

  async function addTransactionsBatch(transactionsToAdd) {
    return bulkAdd('transactions', transactionsToAdd.map(t => ({
      ...t,
      createdAt: new Date().toISOString(),
    })));
  }

  async function updateTransaction(id, changes) {
    return update('transactions', id, changes);
  }

  async function deleteTransaction(id) {
    return remove('transactions', id);
  }

  async function deleteByImportBatch(batchId) {
    return apiAction(`/transactions/import-batch/${batchId}`, { method: 'DELETE' });
  }

  return {
    transactions,
    addTransaction,
    addTransactionsBatch,
    updateTransaction,
    deleteTransaction,
    deleteByImportBatch,
  };
}
