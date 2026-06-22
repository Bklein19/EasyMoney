import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTransactions } from '../../hooks/useTransactions';
import TransactionRow from './TransactionRow';
import TransactionFilters from './TransactionFilters';
import { formatCurrency, getAmountClass } from '../../utils/formatters';
import { useAccounts } from '../../hooks/useAccounts';
import { useCategories } from '../../hooks/useCategories';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import { buildAccountMap, isExcludedFromCashFlow, isExpense, isIncome, isInvestmentMovement } from '../../utils/transactionSemantics';
import './TransactionsPage.css';

const TRANSACTION_PAGE_SIZE = 100;
const AI_CATEGORIZATION_LIMIT = 100;
const AI_CATEGORIZATION_TIMEOUT_MS = 90_000;
const TRANSACTIONS_WORKING_INDICATOR_DELAY_MS = 500;
const BULK_CATEGORY_UNSET = '__bulk_category_unset__';
const BULK_CATEGORY_UNCATEGORIZED = '__bulk_category_uncategorized__';

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

export default function TransactionsPage() {
  const [filters, setFilters] = useState({});
  const [isFilterPending, startFilterTransition] = useTransition();
  const [isCreatingBulkCategory, setIsCreatingBulkCategory] = useState(false);
  const [newBulkCategoryName, setNewBulkCategoryName] = useState('');
  const [pendingBulkCategoryValue, setPendingBulkCategoryValue] = useState(null);
  const [aiCategorization, setAiCategorization] = useState(null);
  const [aiCategorizationError, setAiCategorizationError] = useState('');
  const [openAiApiKeyDraft, setOpenAiApiKeyDraft] = useState('');
  const [selectedAiSuggestionIds, setSelectedAiSuggestionIds] = useState(new Set());
  const [aiQuestionCategoryByKey, setAiQuestionCategoryByKey] = useState({});
  const [ignoredAiQuestionKeys, setIgnoredAiQuestionKeys] = useState(new Set());
  const [aiTransactionModal, setAiTransactionModal] = useState(null);
  const [isAiCategorizing, setIsAiCategorizing] = useState(false);
  const [aiReviewStartedAt, setAiReviewStartedAt] = useState(null);
  const [aiReviewElapsedSeconds, setAiReviewElapsedSeconds] = useState(0);
  const [isApplyingAiCategories, setIsApplyingAiCategories] = useState(false);
  const [isSavingOpenAiKey, setIsSavingOpenAiKey] = useState(false);
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
  }, [
    aiCategorization,
    aiCategorizationError,
    isAiCategorizing,
    isCreatingBulkCategory,
    rowVirtualizer,
    transactionsScrollElement,
    visibleTransactions.length,
  ]);

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

  useEffect(() => {
    if (!isAiCategorizing || !aiReviewStartedAt) return undefined;

    const intervalId = window.setInterval(() => {
      setAiReviewElapsedSeconds(Math.floor((Date.now() - aiReviewStartedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isAiCategorizing, aiReviewStartedAt]);

  const bulkCategorySelectValue = pendingBulkCategoryValue ?? BULK_CATEGORY_UNSET;
  const aiSuggestions = aiCategorization?.suggestions ?? [];
  const aiQuestions = aiCategorization?.questions ?? [];
  const activeAiQuestions = aiQuestions
    .map((question, index) => ({ ...question, key: `${question.pattern}-${index}` }))
    .filter(question => !ignoredAiQuestionKeys.has(question.key));
  const selectedAiSuggestions = aiSuggestions.filter(suggestion => selectedAiSuggestionIds.has(suggestion.transactionId));
  const loadedTransactionByLedgerId = useMemo(() => {
    const map = {};
    for (const transaction of visibleTransactions) {
      if (transaction.ledgerTransactionId) map[transaction.ledgerTransactionId] = transaction;
    }
    return map;
  }, [visibleTransactions]);
  const toAiTransactionDisplay = (transaction) => transaction ? ({
    transactionId: transaction.ledgerTransactionId || transaction.transactionId || String(transaction.id || ''),
    date: transaction.date,
    amount: transaction.amount,
    description: transaction.description,
    merchant: transaction.merchant,
    account: typeof transaction.account === 'string'
      ? transaction.account
      : [accountMap[transaction.accountId]?.institution, accountMap[transaction.accountId]?.name].filter(Boolean).join(' ') || null,
  }) : null;
  const getSuggestionTransaction = (suggestion) =>
    suggestion.transaction || toAiTransactionDisplay(loadedTransactionByLedgerId[suggestion.transactionId]);
  const getQuestionTransactions = (question) => {
    const embedded = question.transactions ?? [];
    const embeddedIds = new Set(embedded.map(transaction => transaction.transactionId));
    const hydrated = question.transactionIds
      .filter(id => !embeddedIds.has(id))
      .map(id => toAiTransactionDisplay(loadedTransactionByLedgerId[id]))
      .filter(Boolean);
    return [...embedded, ...hydrated];
  };
  const getAiTransactionTitle = (transaction) => transaction?.merchant || transaction?.description || 'Transaction';
  const getAiTransactionSummary = (transaction) => {
    if (!transaction) return 'Transaction details unavailable';
    return `${getAiTransactionTitle(transaction)} · ${formatCurrency(transaction.amount, true)}`;
  };
  const openAiTransactionModal = async ({ title, subtitle, transactionIds = [], transactions = [] }) => {
    const existing = transactions.filter(Boolean);
    const existingIds = new Set(existing.map(transaction => transaction.transactionId));
    const missingIds = transactionIds.filter(id => id && !existingIds.has(id));

    setAiTransactionModal({
      title,
      subtitle,
      transactions: existing,
      isLoading: missingIds.length > 0,
    });

    if (!missingIds.length) return;

    try {
      const details = await trpcClient.transactions.aiCategorizationTransactionDetails.query({
        transactionIds: missingIds,
      });
      setAiTransactionModal(previous => previous ? {
        ...previous,
        transactions: [...existing, ...(details.transactions ?? [])],
        isLoading: false,
      } : previous);
    } catch (error) {
      setAiCategorizationError(error instanceof Error ? error.message : String(error));
      setAiTransactionModal(previous => previous ? { ...previous, isLoading: false } : previous);
    }
  };

  const formatTransactionCount = (count) => `${count.toLocaleString()} matching transaction${count === 1 ? '' : 's'}`;

  const confirmLargeBulkChange = (count, categoryName) => {
    if (count <= 50) return true;
    return window.confirm(
      `This will set the category for ${formatTransactionCount(count)} to "${categoryName}". This is a bulk edit and cannot be automatically undone.\n\nContinue?`
    );
  };

  const handleBulkCategoryChange = async (categoryId) => {
    const nextCategoryId = categoryId === BULK_CATEGORY_UNCATEGORIZED ? null : Number(categoryId);
    return categorizeMatchingTransactions(nextCategoryId);
  };

  const handleApplyBulkCategory = async (categoryValue = bulkCategorySelectValue) => {
    if (categoryValue === BULK_CATEGORY_UNSET || totalCount === 0) return;

    const categoryName = categoryValue === BULK_CATEGORY_UNCATEGORIZED
      ? 'Uncategorized'
      : categoryValue
      ? categories.find(category => String(category.id) === String(categoryValue))?.name || 'selected category'
      : 'Uncategorized';

    if (!confirmLargeBulkChange(totalCount, categoryName)) return;
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

  const handlePreviewAiCategorization = async () => {
    setIsAiCategorizing(true);
    setAiReviewStartedAt(Date.now());
    setAiReviewElapsedSeconds(0);
    setAiCategorizationError('');
    setAiCategorization({
      configured: true,
      model: null,
      scanned: 0,
      suggestions: [],
      questions: [],
      message: `Scanning up to ${AI_CATEGORIZATION_LIMIT} uncategorized transactions...`,
    });
    try {
      const result = await withTimeout(
        trpcClient.transactions.aiCategorizationPreview.mutate({ limit: AI_CATEGORIZATION_LIMIT }),
        AI_CATEGORIZATION_TIMEOUT_MS,
        `AI categorization took longer than ${Math.round(AI_CATEGORIZATION_TIMEOUT_MS / 1000)} seconds. Try again with fewer uncategorized transactions or check the server logs.`
      );
      setAiCategorization(result);
      setSelectedAiSuggestionIds(new Set((result.suggestions ?? []).map(suggestion => suggestion.transactionId)));
      setAiQuestionCategoryByKey({});
      setIgnoredAiQuestionKeys(new Set());
    } catch (error) {
      setAiCategorization(null);
      setAiCategorizationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAiCategorizing(false);
      setAiReviewStartedAt(null);
    }
  };

  const handleApplyAiCategorization = async () => {
    const suggestions = selectedAiSuggestions;
    if (!suggestions.length) return;
    if (!window.confirm(`Apply ${suggestions.length} AI category suggestions?`)) return;

    setIsApplyingAiCategories(true);
    setAiCategorizationError('');
    try {
      const result = await trpcClient.transactions.applyAiCategorization.mutate({
        suggestions: suggestions.map(suggestion => ({
          transactionId: suggestion.transactionId,
          categoryId: suggestion.categoryId,
        })),
      });
      const appliedIds = new Set(result.appliedTransactionIds ?? []);
      setAiCategorization(previous => previous ? {
        ...previous,
        suggestions: previous.suggestions.map(suggestion => appliedIds.has(suggestion.transactionId)
          ? { ...suggestion, applied: true }
          : suggestion),
        appliedCount: result.count,
        skippedCount: result.skipped?.length ?? 0,
      } : previous);
      setSelectedAiSuggestionIds(previous => {
        const next = new Set(previous);
        for (const id of appliedIds) next.delete(id);
        return next;
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() }),
        queryClient.invalidateQueries({ queryKey: ['app', 'transactions', 'infinite'] }),
      ]);
    } catch (error) {
      setAiCategorizationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsApplyingAiCategories(false);
    }
  };

  const toggleAiSuggestion = (transactionId) => {
    setSelectedAiSuggestionIds(previous => {
      const next = new Set(previous);
      if (next.has(transactionId)) next.delete(transactionId);
      else next.add(transactionId);
      return next;
    });
  };

  const selectAllAiSuggestions = () => {
    setSelectedAiSuggestionIds(new Set(aiSuggestions.filter(suggestion => !suggestion.applied).map(suggestion => suggestion.transactionId)));
  };

  const clearAiSuggestionSelection = () => {
    setSelectedAiSuggestionIds(new Set());
  };

  const setAiQuestionCategory = (questionKey, categoryId) => {
    setAiQuestionCategoryByKey(previous => ({
      ...previous,
      [questionKey]: categoryId,
    }));
  };

  const ignoreAiQuestion = (questionKey) => {
    setIgnoredAiQuestionKeys(previous => new Set([...previous, questionKey]));
  };

  const applyAiQuestion = async (question) => {
    const categoryId = aiQuestionCategoryByKey[question.key];
    if (!categoryId || !question.transactionIds.length) return;
    const categoryName = categories.find(category => String(category.id) === String(categoryId))?.name || 'selected category';
    if (!confirmLargeBulkChange(question.transactionIds.length, categoryName)) return;

    setIsApplyingAiCategories(true);
    setAiCategorizationError('');
    try {
      const result = await trpcClient.transactions.applyAiCategorization.mutate({
        suggestions: question.transactionIds.map(transactionId => ({
          transactionId,
          categoryId,
        })),
      });
      setAiCategorization(previous => previous ? {
        ...previous,
        appliedCount: (previous.appliedCount ?? 0) + result.count,
        skippedCount: (previous.skippedCount ?? 0) + (result.skipped?.length ?? 0),
      } : previous);
      if (result.count > 0) ignoreAiQuestion(question.key);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() }),
        queryClient.invalidateQueries({ queryKey: ['app', 'transactions', 'infinite'] }),
      ]);
    } catch (error) {
      setAiCategorizationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsApplyingAiCategories(false);
    }
  };

  const handleSaveOpenAiKey = async (event) => {
    event.preventDefault();
    const apiKey = openAiApiKeyDraft.trim();
    if (!apiKey) return;

    setIsSavingOpenAiKey(true);
    setAiCategorizationError('');
    try {
      await trpcClient.transactions.saveOpenAiCategorizationSettings.mutate({ apiKey });
      setOpenAiApiKeyDraft('');
      setAiCategorization(previous => previous ? {
        ...previous,
        configured: true,
        message: 'Saved OPENAI_API_KEY to .env.local.',
      } : {
        configured: true,
        message: 'Saved OPENAI_API_KEY to .env.local.',
        scanned: 0,
        suggestions: [],
        questions: [],
      });
    } catch (error) {
      setAiCategorizationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingOpenAiKey(false);
    }
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
                <div className="transactions-bulk-category" aria-label="Bulk categorization">
                  <select
                    id="bulkTransactionCategory"
                    className="filter-input"
                    value={bulkCategorySelectValue}
                    disabled={totalCount === 0}
                    aria-label="Bulk category"
                    onChange={(event) => {
                      if (event.target.value === '__add_custom__') {
                        setIsCreatingBulkCategory(true);
                        return;
                      }
                      resetBulkCategoryCreate();
                      setPendingBulkCategoryValue(event.target.value);
                    }}
                  >
                    <option value={BULK_CATEGORY_UNSET} disabled>Choose category</option>
                    <option value={BULK_CATEGORY_UNCATEGORIZED}>Uncategorized</option>
                    {categories.map(category => (
                      <option key={category.id} value={category.id}>{category.name}</option>
                    ))}
                    <option value="__add_custom__">+ Add custom category</option>
                  </select>
                  <button
                    className="btn btn--secondary btn--sm bulk-category-action__apply"
                    type="button"
                    disabled={
                      totalCount === 0 ||
                      bulkCategorySelectValue === BULK_CATEGORY_UNSET
                    }
                    onClick={() => handleApplyBulkCategory()}
                  >
                    Apply
                  </button>
                </div>
                <button
                  className="btn btn--secondary btn--sm"
                  type="button"
                  disabled={isAiCategorizing || isApplyingAiCategories}
                  onClick={handlePreviewAiCategorization}
                  title="Review uncategorized transactions with your server-side OpenAI key"
                >
                  {isAiCategorizing ? 'Reviewing...' : 'Review uncategorized'}
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
            {selectedAiSuggestions.length > 0 && (
              <div className="transactions-ai-apply">
                <button
                  className="btn btn--primary btn--sm"
                  type="button"
                  disabled={isApplyingAiCategories}
                  onClick={handleApplyAiCategorization}
                >
                  {isApplyingAiCategories ? 'Applying...' : `Apply ${selectedAiSuggestions.length} AI suggestions`}
                </button>
              </div>
            )}
            {(isAiCategorizing || aiCategorization || aiCategorizationError) && (
              <div className="ai-category-status">
                {isAiCategorizing && (
                  <div className="ai-category-action__progress" role="status" aria-live="polite">
                    <div className="ai-category-action__progress-bar" aria-hidden="true" />
                    <span>
                      Calling OpenAI in batches. {aiReviewElapsedSeconds}s elapsed.
                    </span>
                  </div>
                )}
                {aiCategorization?.configured === false && (
                  <>
                    <p className="ai-category-action__message">{aiCategorization.message}</p>
                    <form className="ai-category-key-form" onSubmit={handleSaveOpenAiKey}>
                      <input
                        className="input input--sm"
                        type="password"
                        value={openAiApiKeyDraft}
                        onChange={(event) => setOpenAiApiKeyDraft(event.target.value)}
                        placeholder="OpenAI API key"
                        autoComplete="off"
                      />
                    <button
                      className="btn btn--primary btn--sm"
                      type="submit"
                      disabled={!openAiApiKeyDraft.trim() || isSavingOpenAiKey}
                    >
                      {isSavingOpenAiKey ? 'Saving...' : 'Save key'}
                    </button>
                  </form>
                </>
              )}
              {aiCategorization?.message && aiCategorization.configured !== false && (
                <p className="ai-category-action__message">{aiCategorization.message}</p>
              )}
              {aiCategorization?.configured && (
                <div className="ai-category-action__summary">
                  <span>{aiCategorization.scanned} scanned</span>
                  <span>{aiSuggestions.filter(suggestion => !suggestion.applied).length} suggestions</span>
                  <span>{activeAiQuestions.length} questions</span>
                </div>
              )}
              {aiCategorization?.appliedCount > 0 && (
                <p className="ai-category-action__message">
                  Applied {aiCategorization.appliedCount} category updates.
                  {aiCategorization.skippedCount > 0 ? ` Skipped ${aiCategorization.skippedCount} already-categorized or missing transactions.` : ''}
                </p>
              )}
              {aiCategorizationError && (
                <p className="ai-category-action__error">{aiCategorizationError}</p>
              )}
            </div>
          )}
          </div>
          {aiCategorization?.configured && (aiSuggestions.length > 0 || aiQuestions.length > 0) && (
            <div className="ai-category-review">
              {aiSuggestions.length > 0 && (
                <section>
                  <div className="ai-category-review__section-header">
                    <h4>AI suggestions</h4>
                    <div className="ai-category-review__actions">
                      <button type="button" className="btn btn--ghost btn--sm" onClick={selectAllAiSuggestions}>
                        Select all
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={clearAiSuggestionSelection}>
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="ai-category-review__list">
                    {aiSuggestions.slice(0, 50).map(suggestion => (
                      <label
                        className={`ai-category-review__item ai-category-review__item--selectable ${suggestion.applied ? 'ai-category-review__item--applied' : ''}`}
                        key={suggestion.transactionId}
                      >
                        <input
                          type="checkbox"
                          checked={selectedAiSuggestionIds.has(suggestion.transactionId)}
                          disabled={suggestion.applied}
                          onChange={() => toggleAiSuggestion(suggestion.transactionId)}
                        />
                        <span>
                          <strong>{suggestion.categoryName}</strong>
                          <span>{suggestion.reason}</span>
                          <em>{getAiTransactionSummary(getSuggestionTransaction(suggestion))}</em>
                          <button
                            type="button"
                            className="ai-category-link-button"
                            onClick={(event) => {
                              event.preventDefault();
                              openAiTransactionModal({
                                title: suggestion.categoryName,
                                subtitle: suggestion.reason,
                                transactionIds: [suggestion.transactionId],
                                transactions: getSuggestionTransaction(suggestion) ? [getSuggestionTransaction(suggestion)] : [],
                              });
                            }}
                          >
                            View transaction
                          </button>
                          {suggestion.applied && <em>Applied</em>}
                        </span>
                      </label>
                    ))}
                    {aiSuggestions.length > 50 && (
                      <div className="ai-category-review__more">
                        + {aiSuggestions.length - 50} more suggestions
                      </div>
                    )}
                  </div>
                </section>
              )}
              {aiQuestions.length > 0 && (
                <section>
                  <h4>Needs your call</h4>
                  <div className="ai-category-review__list">
                    {activeAiQuestions.map((question) => (
                      <div className="ai-category-review__item ai-category-question" key={question.key}>
                        <strong>{question.pattern}</strong>
                        <span>{question.reason}</span>
                        <em>{question.transactionIds.length} matching transactions</em>
                        <button
                          type="button"
                          className="ai-category-link-button"
                          onClick={() => openAiTransactionModal({
                            title: question.pattern,
                            subtitle: question.reason,
                            transactionIds: question.transactionIds,
                            transactions: getQuestionTransactions(question),
                          })}
                        >
                          View matching transactions
                        </button>
                        <div className="ai-category-question__actions">
                          <select
                            className="filter-input"
                            value={aiQuestionCategoryByKey[question.key] ?? ''}
                            onChange={(event) => setAiQuestionCategory(question.key, event.target.value)}
                          >
                            <option value="">Choose category</option>
                            {categories.map(category => (
                              <option key={category.id} value={category.id}>{category.name}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            disabled={!aiQuestionCategoryByKey[question.key] || isApplyingAiCategories}
                            onClick={() => applyAiQuestion(question)}
                          >
                            Apply
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => ignoreAiQuestion(question.key)}
                          >
                            Ignore
                          </button>
                        </div>
                      </div>
                    ))}
                    {activeAiQuestions.length === 0 && (
                      <div className="ai-category-review__more">All questions ignored or resolved.</div>
                    )}
                  </div>
                </section>
              )}
            </div>
          )}

          {aiTransactionModal && createPortal((
            <div className="modal-overlay ai-transaction-modal-overlay" onClick={() => setAiTransactionModal(null)}>
              <div className="modal ai-transaction-modal" onClick={(event) => event.stopPropagation()}>
                <div className="modal__header">
                  <div>
                    <div className="modal__title">{aiTransactionModal.title}</div>
                    <p className="ai-transaction-modal__subtitle">{aiTransactionModal.subtitle}</p>
                  </div>
                  <button className="btn btn--ghost btn--sm" type="button" onClick={() => setAiTransactionModal(null)}>
                    Close
                  </button>
                </div>
                <div className="modal__body">
                  <div className="ai-transaction-modal__list">
                    {aiTransactionModal.transactions.map(transaction => (
                      <div className="ai-transaction-modal__row" key={transaction.transactionId}>
                        <div>
                          <strong>{getAiTransactionTitle(transaction)}</strong>
                          <span>{transaction.description || transaction.merchant || 'No description'}</span>
                          <em>{transaction.account || 'Unknown account'} · {transaction.date}</em>
                        </div>
                        <div className={`amount ${getAmountClass(transaction.amount)}`}>
                          {formatCurrency(transaction.amount, true)}
                        </div>
                      </div>
                    ))}
                    {aiTransactionModal.isLoading && (
                      <div className="empty-state-simple">Loading transaction details...</div>
                    )}
                    {!aiTransactionModal.isLoading && aiTransactionModal.transactions.length === 0 && (
                      <div className="empty-state-simple">No transaction details available.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ), document.body)}
          
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
