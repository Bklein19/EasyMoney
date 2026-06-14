import { useEffect, useMemo, useReducer, useState } from 'react';
import { add, apiAction, appRequest, bulkAdd, remove, subscribeToDataChanges, update } from '../db/api';

const normalizeId = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  return Number.isNaN(numeric) ? value : numeric;
};

export function useTransactions(filters = {}) {
  const accountId = normalizeId(filters.accountId);
  const categoryId = normalizeId(filters.categoryId);
  const [rows, setRows] = useState([]);
  const [refreshToken, refresh] = useReducer(value => value + 1, 0);
  const query = useMemo(() => ({
    accountId,
    categoryId,
    startDate: filters.startDate,
    endDate: filters.endDate,
    search: filters.searchQuery,
  }), [accountId, categoryId, filters.startDate, filters.endDate, filters.searchQuery]);
  const queryKey = JSON.stringify(query);

  useEffect(() => subscribeToDataChanges(refresh), []);

  useEffect(() => {
    let cancelled = false;
    appRequest('/transactions', JSON.parse(queryKey))
      .then(data => {
        if (!cancelled) setRows(data.transactions.map(fromAppTransaction));
      })
      .catch(error => {
        console.error('Failed to load app transactions', error);
        if (!cancelled) setRows([]);
      });

    return () => {
      cancelled = true;
    };
  }, [queryKey, refreshToken]);

  const transactions = useMemo(() => {
    let result = rows;

    if (filters.type === 'income') {
      result = result.filter(t => t.amount > 0);
    } else if (filters.type === 'expense') {
      result = result.filter(t => t.amount < 0);
    }

    return result;
  }, [rows, filters.type]);

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

function fromAppTransaction(transaction) {
  return {
    id: transaction.id,
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
