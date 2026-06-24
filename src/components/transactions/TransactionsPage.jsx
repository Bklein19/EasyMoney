import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useNavigate } from 'react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useTransactions } from '../../hooks/useTransactions';
import TransactionRow from './TransactionRow';
import TransactionFilters from './TransactionFilters';
import { formatCurrency } from '../../utils/formatters';
import { useAccounts } from '../../hooks/useAccounts';
import { useCategories } from '../../hooks/useCategories';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import { buildAccountMap, isExcludedFromCashFlow, isExpense, isIncome, isInvestmentMovement } from '../../utils/transactionSemantics';
import './TransactionsPage.css';

const TRANSACTION_PAGE_SIZE = 100;
const TRANSACTIONS_WORKING_INDICATOR_DELAY_MS = 500;
const BULK_CATEGORY_UNSET = '__bulk_category_unset__';
const BULK_CATEGORY_UNCATEGORIZED = '__bulk_category_uncategorized__';
const TRANSACTION_SORT_COLUMNS = [
  { key: 'date', label: 'Date', asc: 'date_asc', desc: 'date_desc', initial: 'date_desc' },
  { key: 'description', label: 'Description', asc: 'description_asc', desc: 'description_desc', initial: 'description_asc' },
  { key: 'category', label: 'Category', asc: 'category_asc', desc: 'category_desc', initial: 'category_asc' },
  { key: 'account', label: 'Account', asc: 'account_asc', desc: 'account_desc', initial: 'account_asc' },
  { key: 'amount', label: 'Amount', asc: 'amount_asc', desc: 'amount_desc', initial: 'amount_desc' },
];

export default function TransactionsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({});
  const [isFilterPending, startFilterTransition] = useTransition();
  const [isCreatingBulkCategory, setIsCreatingBulkCategory] = useState(false);
  const [newBulkCategoryName, setNewBulkCategoryName] = useState('');
  const [bulkCategoryUndo, setBulkCategoryUndo] = useState(null);
  const [isApplyingBulkCategory, setIsApplyingBulkCategory] = useState(false);
  const [isRestoringBulkCategory, setIsRestoringBulkCategory] = useState(false);
  const [showTransactionsWorking, setShowTransactionsWorking] = useState(false);
  const [transactionsScrollElement, setTransactionsScrollElement] = useState(null);
  const [transactionsListOffsetTop, setTransactionsListOffsetTop] = useState(0);
  const transactionsListRef = useRef(null);
  const deferredFilters = useDeferredValue(filters);
  const {
    transactions,
    updateTransaction,
    categorizeMatchingTransactions,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    totalCount,
    totals: serverTotals,
  } = useTransactions({
    ...deferredFilters,
    infinite: true,
    limit: TRANSACTION_PAGE_SIZE,
  });
  const { accounts } = useAccounts();
  const { categories, addCategory } = useCategories();
  const deferredTransactions = useDeferredValue(transactions);
  const deferredAccounts = useDeferredValue(accounts);
  const deferredCategories = useDeferredValue(categories);
  const isTransactionsWorking =
    isFilterPending ||
    transactions !== deferredTransactions ||
    accounts !== deferredAccounts ||
    categories !== deferredCategories ||
    filters !== deferredFilters;
  const accountMap = useMemo(() => buildAccountMap(deferredAccounts), [deferredAccounts]);
  const categoryMap = useMemo(() => {
    const map = {};
    deferredCategories.forEach(c => { map[c.id] = c; });
    return map;
  }, [deferredCategories]);
  const visibleTransactions = deferredTransactions;
  const virtualRowCount = hasNextPage ? visibleTransactions.length + 1 : visibleTransactions.length;
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the intended virtual scroller for this dense list.
  const rowVirtualizer = useVirtualizer({
    count: virtualRowCount,
    estimateSize: () => 44,
    getScrollElement: () => transactionsScrollElement,
    getItemKey: (index) => visibleTransactions[index]?.id ?? `loader-${index}`,
    overscan: 8,
    scrollMargin: transactionsListOffsetTop,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    if (!isTransactionsWorking) {
      setShowTransactionsWorking(false);
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setShowTransactionsWorking(true);
    }, TRANSACTIONS_WORKING_INDICATOR_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [isTransactionsWorking]);

  useEffect(() => {
    let cancelled = false;

    trpcClient.transactions.latestCategoryUndo.query()
      .then((undoOperation) => {
        if (!cancelled && undoOperation) setBulkCategoryUndo(undoOperation);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    setTransactionsScrollElement(document.querySelector('.app-main'));
  }, []);

  useLayoutEffect(() => {
    if (!transactionsScrollElement || !transactionsListRef.current) return undefined;

    const updateOffset = () => {
      if (!transactionsListRef.current) return;
      const listRect = transactionsListRef.current.getBoundingClientRect();
      const scrollRect = transactionsScrollElement.getBoundingClientRect();
      setTransactionsListOffsetTop(
        listRect.top - scrollRect.top + transactionsScrollElement.scrollTop
      );
      rowVirtualizer.measure();
    };

    updateOffset();

    const resizeObserver = new ResizeObserver(updateOffset);
    resizeObserver.observe(transactionsScrollElement);
    resizeObserver.observe(transactionsListRef.current);
    window.addEventListener('resize', updateOffset);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateOffset);
    };
  }, [isCreatingBulkCategory, rowVirtualizer, transactionsScrollElement, visibleTransactions.length]);

  useEffect(() => {
    const lastVirtualRow = virtualRows[virtualRows.length - 1];
    if (
      lastVirtualRow &&
      lastVirtualRow.index >= visibleTransactions.length - 1 &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, virtualRows, visibleTransactions.length]);

  const bulkCategorySelectValue = BULK_CATEGORY_UNSET;
  const formatTransactionCount = (count) => `${count.toLocaleString()} matching transaction${count === 1 ? '' : 's'}`;
  const activeSortBy = filters.sortBy || 'date_desc';
  const sortColumn = TRANSACTION_SORT_COLUMNS.find(column =>
    activeSortBy === column.asc || activeSortBy === column.desc
  ) || TRANSACTION_SORT_COLUMNS[0];
  const sortDirection = activeSortBy === sortColumn.asc ? 'asc' : 'desc';

  const setColumnSort = (column) => {
    const nextSortBy = activeSortBy === column.asc
      ? column.desc
      : activeSortBy === column.desc
        ? column.asc
        : column.initial;
    handleFilterChange(previous => ({
      ...previous,
      sortBy: nextSortBy === 'date_desc' ? undefined : nextSortBy,
    }));
  };

  const renderSortIcon = (column) => {
    if (sortColumn.key !== column.key) return null;
    return sortDirection === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />;
  };

  const confirmLargeBulkChange = (count, categoryName) => {
    if (count <= 50) return true;
    return window.confirm(
      `This will set the category for ${formatTransactionCount(count)} to "${categoryName}".\n\nContinue?`
    );
  };

  const handleBulkCategoryChange = async (categoryId) => {
    const nextCategoryId = categoryId === BULK_CATEGORY_UNCATEGORIZED ? null : Number(categoryId);
    return categorizeMatchingTransactions(nextCategoryId);
  };

  const handleApplyBulkCategory = async (categoryValue = bulkCategorySelectValue) => {
    if (categoryValue === BULK_CATEGORY_UNSET || totalCount === 0) return;

    setIsApplyingBulkCategory(true);
    try {
      const result = await handleBulkCategoryChange(categoryValue);
      setBulkCategoryUndo(result.undoOperation ?? null);
    } finally {
      setIsApplyingBulkCategory(false);
    }
  };

  const handleUndoBulkCategory = async () => {
    if (!bulkCategoryUndo?.id) return;

    setIsRestoringBulkCategory(true);
    try {
      await trpcClient.transactions.restoreCategories.mutate({
        undoOperationId: bulkCategoryUndo.id,
      });
      setBulkCategoryUndo(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() }),
        queryClient.invalidateQueries({ queryKey: ['app', 'transactions', 'infinite'] }),
      ]);
    } finally {
      setIsRestoringBulkCategory(false);
    }
  };

  const inferBulkCategoryType = () => {
    const normalizedName = newBulkCategoryName.trim().toLowerCase();
    if (normalizedName === 'investment' || normalizedName === 'investments') return 'investment';
    if (filters.flowType === 'income') return 'income';
    if (filters.flowType === 'investment') return 'investment';
    if (filters.flowType === 'internal_transfer') return 'internal_transfer';
    if (filters.flowType === 'transfer' || filters.flowType === 'card_payment') return 'transfer';
    return 'expense';
  };

  const resetBulkCategoryCreate = () => {
    setIsCreatingBulkCategory(false);
    setNewBulkCategoryName('');
  };

  const handleCreateBulkCategory = async (event) => {
    event.preventDefault();

    const name = newBulkCategoryName.trim();
    if (!name) return;

    if (!confirmLargeBulkChange(totalCount, name)) return;

    const existing = categories.find(category => category.name.toLowerCase() === name.toLowerCase());
    const categoryId = existing?.id || await addCategory({
      name,
      type: inferBulkCategoryType(),
      color: '#94a3b8',
      icon: 'tag'
    });

    const result = await handleBulkCategoryChange(categoryId);
    setBulkCategoryUndo(result.undoOperation ?? null);
    resetBulkCategoryCreate();
  };

  const handleFilterChange = useCallback((nextFilters) => {
    startFilterTransition(() => {
      setBulkCategoryUndo(null);
      setFilters(nextFilters);
    });
  }, []);

  const loadedTotals = useMemo(() => {
    return visibleTransactions.reduce((summary, tx) => {
      if (isIncome(tx, accountMap, categoryMap)) summary.income += tx.amount;
      if (isExpense(tx, accountMap, categoryMap)) summary.expenses += Math.abs(tx.amount);
      if (isInvestmentMovement(tx, accountMap, categoryMap)) summary.investments += Math.abs(tx.amount);
      else if (isExcludedFromCashFlow(tx, accountMap, categoryMap)) summary.internalMovement += Math.abs(tx.amount);
      summary.net = summary.income - summary.expenses;
      return summary;
    }, { income: 0, expenses: 0, internalMovement: 0, investments: 0, net: 0 });
  }, [visibleTransactions, accountMap, categoryMap]);
  const totals = serverTotals ?? loadedTotals;

  return (
    <div className="page">
      <div className="page__header transactions-page__header stagger-in">
        <div>
          <h1 className="page__title">Transactions</h1>
        </div>
        <TransactionFilters
          filters={filters}
          setFilters={handleFilterChange}
        />
        {showTransactionsWorking && (
          <div className="transactions-working" role="status" aria-live="polite">
            <span className="transactions-working__spinner" aria-hidden="true" />
            <span>Updating transactions...</span>
          </div>
        )}
      </div>

      <div className="stagger-in">
        <div className="transactions-container">
          <div className="transactions-header">
            <div className="transactions-header__top">
              <div className="transactions-heading">
                <div className="transactions-meta">
                  <span>{formatTransactionCount(totalCount)}</span>
                  <span>Income {formatCurrency(totals.income)}</span>
                  <span>Expenses {formatCurrency(totals.expenses)}</span>
                  {totals.internalMovement > 0 && (
                    <span>Internal {formatCurrency(totals.internalMovement)}</span>
                  )}
                  {totals.investments > 0 && (
                    <span>Investments {formatCurrency(totals.investments)}</span>
                  )}
                  <span>Net {formatCurrency(totals.net, true)}</span>
                </div>
              </div>
              <div className="transactions-header-actions">
                {bulkCategoryUndo && (
                  <div className="transactions-bulk-undo" role="status" aria-live="polite">
                    <span>
                      Categorized {formatTransactionCount(bulkCategoryUndo.count)} as {bulkCategoryUndo.categoryName}.
                    </span>
                    <button
                      className="btn btn--ghost btn--sm"
                      type="button"
                      disabled={isRestoringBulkCategory}
                      onClick={handleUndoBulkCategory}
                    >
                      {isRestoringBulkCategory ? 'Undoing...' : 'Undo'}
                    </button>
                    <button
                      className="transaction-feedback-dismiss"
                      type="button"
                      aria-label="Dismiss categorization update"
                      disabled={isRestoringBulkCategory}
                      onClick={() => setBulkCategoryUndo(null)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                <div className="transactions-bulk-category" aria-label="Bulk categorization">
                  <select
                    id="bulkTransactionCategory"
                    className="filter-input"
                    value={bulkCategorySelectValue}
                    disabled={totalCount === 0 || isApplyingBulkCategory || isRestoringBulkCategory}
                    aria-label="Bulk category"
                    onChange={(event) => {
                      if (event.target.value === '__add_custom__') {
                        setIsCreatingBulkCategory(true);
                        return;
                      }
                      resetBulkCategoryCreate();
                      handleApplyBulkCategory(event.target.value);
                    }}
                  >
                    <option value={BULK_CATEGORY_UNSET} disabled>
                      {isApplyingBulkCategory ? 'Categorizing...' : 'Categorize as...'}
                    </option>
                    <option value={BULK_CATEGORY_UNCATEGORIZED}>Uncategorized</option>
                    {categories.map(category => (
                      <option key={category.id} value={category.id}>{category.name}</option>
                    ))}
                    <option value="__add_custom__">+ Add custom category</option>
                  </select>
                </div>
                <button
                  className="btn btn--secondary btn--sm"
                  type="button"
                  onClick={() => navigate('/transactions/review?start=1')}
                  title="Review uncategorized merchants with AI"
                >
                  Review with AI
                </button>
              </div>
            </div>
            {isCreatingBulkCategory && (
              <form className="inline-create transactions-inline-create" onSubmit={handleCreateBulkCategory}>
                <input
                  className="input input--sm inline-create__input"
                  value={newBulkCategoryName}
                  onChange={(event) => setNewBulkCategoryName(event.target.value)}
                  placeholder="New category name"
                  autoFocus
                />
                <div className="inline-create__actions">
                  <button className="btn btn--primary btn--sm" type="submit" disabled={!newBulkCategoryName.trim()}>
                    Add
                  </button>
                  <button className="btn btn--ghost btn--sm" type="button" onClick={resetBulkCategoryCreate}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="transactions-table-header" role="row">
            {TRANSACTION_SORT_COLUMNS.map(column => (
              <button
                key={column.key}
                className={`transactions-table-header__cell transactions-table-header__cell--${column.key} ${sortColumn.key === column.key ? 'is-active' : ''}`}
                type="button"
                aria-pressed={sortColumn.key === column.key}
                aria-label={`Sort by ${column.label}${sortColumn.key === column.key ? ` ${sortDirection === 'asc' ? 'ascending' : 'descending'}` : ''}`}
                onClick={() => setColumnSort(column)}
              >
                <span>{column.label}</span>
                {renderSortIcon(column)}
              </button>
            ))}
          </div>

          <div
            ref={transactionsListRef}
            className="transactions-list transactions-list--virtual"
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            {visibleTransactions.length > 0 ? (
              <>
                {virtualRows.map(virtualRow => {
                  const tx = visibleTransactions[virtualRow.index];
                  const isLoaderRow = !tx;

                  return (
                    <div
                      key={virtualRow.key}
                      ref={rowVirtualizer.measureElement}
                      className="transactions-virtual-row"
                      data-index={virtualRow.index}
                      style={{
                        transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
                      }}
                    >
                      {isLoaderRow ? (
                        <div className="transactions-load-more" aria-live="polite">
                          {isFetchingNextPage
                            ? 'Loading more transactions...'
                            : hasNextPage
                              ? 'Loading more transactions...'
                              : 'All matching transactions loaded'}
                        </div>
                      ) : (
                        <TransactionRow
                          transaction={tx}
                          onUpdate={updateTransaction}
                          account={accountMap[tx.accountId]}
                          categories={categories}
                          addCategory={addCategory}
                        />
                      )}
                    </div>
                  );
                })}
              </>
            ) : (
              <div className="empty-state-simple" style={{ height: 200 }}>
                No transactions found for the selected filters.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
