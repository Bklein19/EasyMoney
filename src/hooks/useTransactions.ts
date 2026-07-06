import { useMemo } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { queryClient, trpc, trpcClient } from '../api/trpc';
import type { TransactionListItem } from '../../server/app/types.ts';

interface TransactionFilters {
  accountId?: string | number | null;
  categoryId?: string | number | null;
  startDate?: string | null;
  endDate?: string | null;
  searchQuery?: string | null;
  type?: string | null;
  accountKind?: string | null;
  flowType?: string | null;
  sortBy?: string | null;
  limit?: number;
  infinite?: boolean;
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
    accountKind: filters.accountKind,
    startDate: filters.startDate,
    endDate: filters.endDate,
    search: filters.searchQuery,
    flowType: filters.flowType,
    sortBy: filters.sortBy,
  }), [accountId, categoryId, filters.accountKind, filters.startDate, filters.endDate, filters.searchQuery, filters.flowType, filters.sortBy]);

  const pageSize = filters.limit ?? 100;
  const isInfinite = filters.infinite === true;
  const transactionsQuery = useQuery(trpc.transactions.list.queryOptions(query, {
    enabled: !isInfinite,
    placeholderData: keepPreviousData,
    select: data => data.transactions.map(fromAppTransaction),
  }));
  const infiniteTransactionsQuery = useInfiniteQuery({
    queryKey: ['app', 'transactions', 'infinite', query, pageSize],
    enabled: isInfinite,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => trpcClient.transactions.list.query({
      ...query,
      limit: pageSize,
      offset: pageParam,
    }),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    placeholderData: keepPreviousData,
    select: data => ({
      ...data,
      pages: data.pages.map(page => ({
        ...page,
        transactions: page.transactions.map(fromAppTransaction),
      })),
    }),
  });

  const categorize = useMutation(trpc.transactions.categorize.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() });
      queryClient.invalidateQueries({ queryKey: ['app', 'transactions', 'infinite'] });
    },
  }));
  const categorizeMatching = useMutation(trpc.transactions.categorizeMatching.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() });
      queryClient.invalidateQueries({ queryKey: ['app', 'transactions', 'infinite'] });
    },
  }));

  const transactions = useMemo(() => {
    let result = isInfinite
      ? infiniteTransactionsQuery.data?.pages.flatMap(page => page.transactions) ?? []
      : transactionsQuery.data ?? [];

    if (!isInfinite && filters.type === 'income') {
      result = result.filter(t => t.amount > 0);
    } else if (!isInfinite && filters.type === 'expense') {
      result = result.filter(t => t.amount < 0);
    }

    return result;
  }, [isInfinite, infiniteTransactionsQuery.data, transactionsQuery.data, filters.type]);

  const firstInfinitePage = infiniteTransactionsQuery.data?.pages[0];

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

  async function categorizeMatchingTransactions(categoryId: string | number | null) {
    return categorizeMatching.mutateAsync({
      query,
      categoryId,
    });
  }

  return {
    transactions,
    updateTransaction,
    categorizeTransactions,
    categorizeMatchingTransactions,
    isLoading: isInfinite ? infiniteTransactionsQuery.isLoading : transactionsQuery.isLoading,
    isFetching: isInfinite ? infiniteTransactionsQuery.isFetching : transactionsQuery.isFetching,
    isFetchingNextPage: infiniteTransactionsQuery.isFetchingNextPage,
    fetchNextPage: infiniteTransactionsQuery.fetchNextPage,
    hasNextPage: Boolean(infiniteTransactionsQuery.hasNextPage),
    totalCount: isInfinite ? firstInfinitePage?.totalCount ?? 0 : transactions.length,
    totals: firstInfinitePage?.totals,
    error: isInfinite ? infiniteTransactionsQuery.error : transactionsQuery.error,
  };
}

function fromAppTransaction(transaction: TransactionListItem) {
  return {
    id: transaction.id,
    ledgerTransactionId: transaction.ledgerTransactionId,
    accountId: transaction.account?.id ?? null,
    accountName: transaction.account?.name ?? null,
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
