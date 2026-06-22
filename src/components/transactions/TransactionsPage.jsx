import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
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
  const [isApplyingAiCategories, setIsApplyingAiCategories] = useState(false);
  const [isSavingOpenAiKey, setIsSavingOpenAiKey] = useState(false);
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

  const handlePreviewAiCategorization = async () => {
    setIsAiCategorizing(true);
    setAiCategorizationError('');
    try {
      const result = await trpcClient.transactions.aiCategorizationPreview.mutate({ limit: 500 });
      setAiCategorization(result);
      setSelectedAiSuggestionIds(new Set((result.suggestions ?? []).map(suggestion => suggestion.transactionId)));
      setAiQuestionCategoryByKey({});
      setIgnoredAiQuestionKeys(new Set());
    } catch (error) {
      setAiCategorization(null);
      setAiCategorizationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAiCategorizing(false);
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
            <div className="ai-category-action">
              <div>
                <label>AI categorization</label>
                <p>Reviews uncategorized transactions with your server-side OpenAI key.</p>
              </div>
              <button
                className="btn btn--secondary btn--sm"
                type="button"
                disabled={isAiCategorizing || isApplyingAiCategories}
                onClick={handlePreviewAiCategorization}
              >
                {isAiCategorizing ? 'Reviewing...' : 'Review uncategorized'}
              </button>
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
                  <span>{aiSuggestions.filter(suggestion => !suggestion.applied).length} unapplied suggestions</span>
                  <span>{activeAiQuestions.length} open questions</span>
                </div>
              )}
              {selectedAiSuggestions.length > 0 && (
                <button
                  className="btn btn--primary btn--sm"
                  type="button"
                  disabled={isApplyingAiCategories}
                  onClick={handleApplyAiCategorization}
                >
                  {isApplyingAiCategories ? 'Applying...' : `Apply ${selectedAiSuggestions.length} selected`}
                </button>
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
