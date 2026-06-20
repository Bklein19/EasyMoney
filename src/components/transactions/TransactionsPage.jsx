import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useTransactions } from '../../hooks/useTransactions';
import TransactionRow from './TransactionRow';
import TransactionFilters from './TransactionFilters';
import { formatCurrency, getAmountClass } from '../../utils/formatters';
import { useAccounts } from '../../hooks/useAccounts';
import { useCategories } from '../../hooks/useCategories';
import { buildAccountMap, isExcludedFromCashFlow, isExpense, isIncome, isInvestmentMovement } from '../../utils/transactionSemantics';
import './TransactionsPage.css';

const TRANSACTION_PAGE_SIZE = 100;

export default function TransactionsPage() {
  const [filters, setFilters] = useState({});
  const [isFilterPending, startFilterTransition] = useTransition();
  const [isCreatingBulkCategory, setIsCreatingBulkCategory] = useState(false);
  const [newBulkCategoryName, setNewBulkCategoryName] = useState('');
  const [pendingBulkCategoryValue, setPendingBulkCategoryValue] = useState(null);
  const [transactionsListOffsetTop, setTransactionsListOffsetTop] = useState(0);
  const transactionsListRef = useRef(null);
  const deferredFilters = useDeferredValue(filters);
  const {
    transactions,
    updateTransaction,
    categorizeTransactions,
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
  const transactionCountLabel = useMemo(() => {
    if (totalCount > visibleTransactions.length) {
      return `${visibleTransactions.length} of ${totalCount}`;
    }

    if (hasNextPage) {
      return `${visibleTransactions.length} loaded`;
    }

    return String(visibleTransactions.length);
  }, [hasNextPage, totalCount, visibleTransactions.length]);
  const virtualRowCount = hasNextPage ? visibleTransactions.length + 1 : visibleTransactions.length;
  const rowVirtualizer = useWindowVirtualizer({
    count: virtualRowCount,
    estimateSize: () => 64,
    getItemKey: (index) => visibleTransactions[index]?.id ?? `loader-${index}`,
    overscan: 8,
    scrollMargin: transactionsListOffsetTop,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    setTransactionsListOffsetTop(transactionsListRef.current?.offsetTop ?? 0);
  }, [visibleTransactions.length]);

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

  const filteredCategoryValue = useMemo(() => {
    if (visibleTransactions.length === 0) return '';
    const firstCategory = visibleTransactions[0].categoryId || '';
    const hasMixedCategories = visibleTransactions.some(tx => (tx.categoryId || '') !== firstCategory);
    return hasMixedCategories ? '__mixed__' : String(firstCategory);
  }, [visibleTransactions]);

  const bulkCategorySelectValue = pendingBulkCategoryValue ?? filteredCategoryValue;

  const confirmLargeBulkChange = (count, categoryName) => {
    if (count <= 50) return true;
    return window.confirm(
      `This will set the category for ${count} visible transactions to "${categoryName}". This is a bulk edit and cannot be automatically undone.\n\nContinue?`
    );
  };

  const handleBulkCategoryChange = async (categoryId) => {
    const nextCategoryId = categoryId ? Number(categoryId) : null;
    await categorizeTransactions(visibleTransactions.map(transaction => transaction.id), nextCategoryId);
  };

  const handleApplyBulkCategory = async (categoryValue = bulkCategorySelectValue) => {
    if (categoryValue === '__mixed__' || visibleTransactions.length === 0) return;

    const categoryName = categoryValue
      ? categories.find(category => String(category.id) === String(categoryValue))?.name || 'selected category'
      : 'Uncategorized';

    if (!confirmLargeBulkChange(visibleTransactions.length, categoryName)) return;
    await handleBulkCategoryChange(categoryValue);
    setPendingBulkCategoryValue(null);
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

    if (!confirmLargeBulkChange(visibleTransactions.length, name)) return;

    const existing = categories.find(category => category.name.toLowerCase() === name.toLowerCase());
    const categoryId = existing?.id || await addCategory({
      name,
      type: inferBulkCategoryType(),
      color: '#94a3b8',
      icon: 'tag'
    });

    await handleBulkCategoryChange(categoryId);
    setPendingBulkCategoryValue(null);
    resetBulkCategoryCreate();
  };

  const handleFilterChange = useCallback((nextFilters) => {
    startFilterTransition(() => {
      setPendingBulkCategoryValue(null);
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
      <div className="page__header stagger-in">
        <div>
          <h1 className="page__title">Transactions</h1>
          <p className="page__subtitle">View and categorize your transactions.</p>
        </div>
        {isTransactionsWorking && (
          <div className="transactions-working" role="status" aria-live="polite">
            <span className="transactions-working__spinner" aria-hidden="true" />
            <span>Updating transactions...</span>
          </div>
        )}
      </div>

      <div className="stagger-in">
        <TransactionFilters
          filters={filters}
          setFilters={handleFilterChange}
        />

        <div className="transactions-container">
          <div className="transactions-header">
            <h3 className="dashboard-card-title">
              All Transactions ({transactionCountLabel})
            </h3>
            <div className="bulk-category-action transactions-bulk-actions">
              <div>
                <label htmlFor="bulkTransactionCategory">Bulk category edit</label>
                <p>Applies to the {visibleTransactions.length} loaded matching transactions.</p>
              </div>
              <select
                id="bulkTransactionCategory"
                className="filter-input"
                value={bulkCategorySelectValue}
                disabled={visibleTransactions.length === 0}
                onChange={(event) => {
                  if (event.target.value === '__add_custom__') {
                    setIsCreatingBulkCategory(true);
                    return;
                  }
                  resetBulkCategoryCreate();
                  setPendingBulkCategoryValue(event.target.value);
                }}
              >
                {filteredCategoryValue === '__mixed__' && <option value="__mixed__">Mixed categories</option>}
                <option value="">Uncategorized</option>
                {categories.map(category => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
                <option value="__add_custom__">+ Add custom category</option>
              </select>
              <button
                className="btn btn--secondary btn--sm bulk-category-action__apply"
                type="button"
                disabled={
                  visibleTransactions.length === 0 ||
                  bulkCategorySelectValue === '__mixed__' ||
                  bulkCategorySelectValue === filteredCategoryValue
                }
                onClick={() => handleApplyBulkCategory()}
              >
                Apply to {visibleTransactions.length}
              </button>
              {isCreatingBulkCategory && (
                <form className="inline-create" onSubmit={handleCreateBulkCategory}>
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
            <div className="transactions-totals" aria-label="Filtered transaction totals">
              <div className="transactions-total">
                <span>Income</span>
                <strong className="amount amount--positive">{formatCurrency(totals.income)}</strong>
              </div>
              <div className="transactions-total">
                <span>Expenses</span>
                <strong className="amount amount--negative">{formatCurrency(totals.expenses)}</strong>
              </div>
              {totals.internalMovement > 0 && (
                <div className="transactions-total">
                  <span>Internal Movement</span>
                  <strong className="amount amount--neutral">{formatCurrency(totals.internalMovement)}</strong>
                </div>
              )}
              {totals.investments > 0 && (
                <div className="transactions-total">
                  <span>Investments</span>
                  <strong className="amount amount--neutral">{formatCurrency(totals.investments)}</strong>
                </div>
              )}
              <div className="transactions-total">
                <span>Net</span>
                <strong className={`amount ${getAmountClass(totals.net)}`}>{formatCurrency(totals.net, true)}</strong>
              </div>
            </div>
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
