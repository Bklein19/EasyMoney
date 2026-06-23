import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { useCategories } from '../../hooks/useCategories';
import { formatCurrency } from '../../utils/formatters';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import './TransactionsPage.css';

const AI_CATEGORIZATION_GROUP_LIMIT = 100;
const AI_CATEGORIZATION_TIMEOUT_MS = 90_000;

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

export default function TransactionReviewPage() {
  const [searchParams] = useSearchParams();
  const hasStartedFromUrl = useRef(false);
  const [aiCategorization, setAiCategorization] = useState(null);
  const [aiCategorizationError, setAiCategorizationError] = useState('');
  const [openAiApiKeyDraft, setOpenAiApiKeyDraft] = useState('');
  const [ignoredAiQuestionKeys, setIgnoredAiQuestionKeys] = useState(new Set());
  const [categoryByReviewKey, setCategoryByReviewKey] = useState({});
  const [expandedReviewKey, setExpandedReviewKey] = useState(null);
  const [isAiCategorizing, setIsAiCategorizing] = useState(false);
  const [aiReviewStartedAt, setAiReviewStartedAt] = useState(null);
  const [aiReviewElapsedSeconds, setAiReviewElapsedSeconds] = useState(0);
  const [isApplyingAiCategories, setIsApplyingAiCategories] = useState(false);
  const [isSavingOpenAiKey, setIsSavingOpenAiKey] = useState(false);
  const { categories } = useCategories();

  const getSuggestionTransaction = (suggestion) => suggestion.transactions?.[0] || suggestion.transaction || null;
  const getQuestionTransactions = (question) => question.transactions ?? [];
  const getAiTransactionTitle = (transaction) => transaction?.merchant || transaction?.description || 'Transaction';
  const getSuggestionLabel = (suggestion) => {
    if (suggestion.decisionKind === 'transfer') return 'Transfer';
    return suggestion.categoryName || 'Suggested';
  };
  const getReviewRowLabel = (row) => {
    if (row.type === 'question') return 'Needs review';
    if (row.decisionKind === 'transfer') return 'Transfer';
    return row.suggestedCategoryName || 'Suggested';
  };
  const formatTransactionCount = (count) => `${count.toLocaleString()} matching transaction${count === 1 ? '' : 's'}`;

  const aiSuggestions = useMemo(() => aiCategorization?.suggestions ?? [], [aiCategorization?.suggestions]);
  const aiQuestions = useMemo(() => aiCategorization?.questions ?? [], [aiCategorization?.questions]);
  const activeAiQuestions = useMemo(() => aiQuestions
    .map((question, index) => ({ ...question, key: `${question.groupId || question.pattern}-${index}` }))
    .filter(question => !ignoredAiQuestionKeys.has(question.key)), [aiQuestions, ignoredAiQuestionKeys]);
  const suggestionSelectionId = (suggestion) => suggestion.id ?? suggestion.transactionId;
  const suggestionTransactionIds = (suggestion) => suggestion.transactionIds ?? [suggestion.transactionId].filter(Boolean);
  const reviewRows = useMemo(() => [
    ...aiSuggestions
      .filter(suggestion => !suggestion.applied)
      .map(suggestion => ({
        type: 'suggestion',
        key: suggestionSelectionId(suggestion),
        merchantName: suggestion.merchantName || getAiTransactionTitle(getSuggestionTransaction(suggestion)),
        transactionIds: suggestionTransactionIds(suggestion),
        transactionCount: suggestion.transactionCount ?? suggestionTransactionIds(suggestion).length,
        totalAmount: suggestion.totalAmount,
        reason: suggestion.reason,
        decisionKind: suggestion.decisionKind,
        suggestedCategoryName: getSuggestionLabel(suggestion),
        categoryId: categoryByReviewKey[suggestionSelectionId(suggestion)] ?? String(suggestion.categoryId),
        transactions: suggestion.transactions ?? (getSuggestionTransaction(suggestion) ? [getSuggestionTransaction(suggestion)] : []),
      })),
    ...activeAiQuestions.map(question => ({
      type: 'question',
      key: question.key,
      merchantName: question.pattern,
      transactionIds: question.transactionIds,
      transactionCount: question.transactionCount ?? question.transactionIds.length,
      totalAmount: question.totalAmount,
      reason: question.reason,
      decisionKind: question.decisionKind,
      suggestedCategoryName: '',
      categoryId: categoryByReviewKey[question.key] ?? '',
      transactions: getQuestionTransactions(question),
    })),
  ], [activeAiQuestions, aiSuggestions, categoryByReviewKey]);
  const selectedReviewRows = reviewRows.filter(row => row.categoryId && row.transactionIds.length);

  useEffect(() => {
    if (!isAiCategorizing || !aiReviewStartedAt) return undefined;

    const intervalId = window.setInterval(() => {
      setAiReviewElapsedSeconds(Math.floor((Date.now() - aiReviewStartedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isAiCategorizing, aiReviewStartedAt]);

  const confirmLargeBulkChange = (count, categoryName) => {
    if (count <= 50) return true;
    return window.confirm(
      `This will set the category for ${formatTransactionCount(count)} to "${categoryName}".\n\nContinue?`
    );
  };

  const renderTransactionPreview = (transactions, totalCount) => {
    const rows = transactions ?? [];
    if (!rows.length) return null;

    return (
      <div className="transaction-review-card__transactions">
        {rows.map(transaction => (
          <div className="transaction-review-card__transaction" key={transaction.transactionId}>
            <div>
              <strong>{getAiTransactionTitle(transaction)}</strong>
              <span>{transaction.account || 'Unknown account'} · {transaction.date}</span>
            </div>
            <span>{formatCurrency(transaction.amount, true)}</span>
          </div>
        ))}
        {totalCount > rows.length && (
          <div className="transaction-review-card__transactions-more">
            + {totalCount - rows.length} more in this merchant group
          </div>
        )}
      </div>
    );
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
      groupCount: 0,
      suggestions: [],
      questions: [],
      message: `Grouping uncategorized transactions and reviewing the top ${AI_CATEGORIZATION_GROUP_LIMIT} merchant groups...`,
    });
    try {
      const result = await withTimeout(
        trpcClient.transactions.aiCategorizationPreview.mutate({ limit: AI_CATEGORIZATION_GROUP_LIMIT }),
        AI_CATEGORIZATION_TIMEOUT_MS,
        `AI categorization took longer than ${Math.round(AI_CATEGORIZATION_TIMEOUT_MS / 1000)} seconds. Try again with fewer uncategorized transactions or check the server logs.`
      );
      setAiCategorization(result);
      setCategoryByReviewKey({});
      setIgnoredAiQuestionKeys(new Set());
      setExpandedReviewKey(null);
    } catch (error) {
      setAiCategorization(null);
      setAiCategorizationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAiCategorizing(false);
      setAiReviewStartedAt(null);
    }
  };

  useEffect(() => {
    if (hasStartedFromUrl.current || searchParams.get('start') !== '1') return;
    hasStartedFromUrl.current = true;
    handlePreviewAiCategorization();
  }, [searchParams]);

  const setReviewCategory = (reviewKey, categoryId) => {
    setCategoryByReviewKey(previous => ({
      ...previous,
      [reviewKey]: categoryId,
    }));
  };

  const applySelectedReviewRows = async () => {
    if (!selectedReviewRows.length) return;
    const transactionCount = selectedReviewRows.reduce((count, row) => count + row.transactionIds.length, 0);
    if (!confirmLargeBulkChange(transactionCount, 'the selected categories')) return;

    setIsApplyingAiCategories(true);
    setAiCategorizationError('');
    try {
      const result = await trpcClient.transactions.applyAiCategorization.mutate({
        suggestions: selectedReviewRows.flatMap(row => row.transactionIds.map(transactionId => ({
          transactionId,
          categoryId: row.categoryId,
        }))),
      });
      const appliedIds = new Set(result.appliedTransactionIds ?? []);
      const appliedQuestionKeys = new Set(
        selectedReviewRows
          .filter(row => row.type === 'question' && row.transactionIds.some(transactionId => appliedIds.has(transactionId)))
          .map(row => row.key)
      );
      setAiCategorization(previous => previous ? {
        ...previous,
        suggestions: previous.suggestions.map(suggestion => suggestionTransactionIds(suggestion).some(transactionId => appliedIds.has(transactionId))
          ? { ...suggestion, applied: true }
          : suggestion),
        appliedCount: (previous.appliedCount ?? 0) + result.count,
        skippedCount: (previous.skippedCount ?? 0) + (result.skipped?.length ?? 0),
      } : previous);
      if (appliedQuestionKeys.size > 0) {
        setIgnoredAiQuestionKeys(previous => new Set([...previous, ...appliedQuestionKeys]));
      }
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

  const progressTotal = reviewRows.length + (aiCategorization?.appliedCount ?? 0);
  const progressDone = aiCategorization?.appliedCount ?? 0;
  const progressPercent = progressTotal === 0 ? 0 : Math.round((progressDone / progressTotal) * 100);

  return (
    <div className="page transaction-review-page">
      <div className="page__header transaction-review-page__header stagger-in">
        <div>
          <h1 className="page__title transaction-review-breadcrumbs">
            <Link to="/transactions">Transactions</Link>
            <span aria-hidden="true">&gt;</span>
            <span>Review</span>
          </h1>
        </div>
        <div className="transaction-review-page__actions">
          {!isAiCategorizing && (
            <button
              className="btn btn--secondary btn--sm"
              type="button"
              disabled={isApplyingAiCategories}
              onClick={handlePreviewAiCategorization}
            >
              {aiCategorization ? 'Run again' : 'Categorize with AI'}
            </button>
          )}
        </div>
      </div>

      <div className="transaction-review-shell stagger-in">
        {(isAiCategorizing || aiCategorization || aiCategorizationError) ? (
          <>
            <div className="ai-category-status transaction-review-status">
              {isAiCategorizing && (
                <div className="ai-category-action__progress" role="status" aria-live="polite">
                  <div className="ai-category-action__progress-bar" aria-hidden="true" />
                  <span>Reviewing... {aiReviewElapsedSeconds}s</span>
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
              {!isAiCategorizing && aiCategorization?.message && aiCategorization.configured !== false && (
                <p className="ai-category-action__message">{aiCategorization.message}</p>
              )}
              {!isAiCategorizing && aiCategorization?.configured && (
                <div className="ai-category-action__summary">
                  <span>{aiCategorization.scanned} transactions scanned</span>
                  {typeof aiCategorization.groupCount === 'number' && (
                    <span>{aiCategorization.groupCount} merchant groups</span>
                  )}
                  {typeof aiCategorization.reviewedGroupCount === 'number' && (
                    <span>{aiCategorization.reviewedGroupCount} groups reviewed by AI</span>
                  )}
                  <span>{aiSuggestions.filter(suggestion => !suggestion.applied).length} suggestions</span>
                  <span>{activeAiQuestions.length} questions</span>
                  <span>{progressDone} applied</span>
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

            {aiCategorization?.configured && (aiSuggestions.length > 0 || aiQuestions.length > 0) && (
              <div className="transaction-review-deck">
                <div className="transaction-review-progress" aria-label={`${progressDone} of ${progressTotal} reviewed`}>
                  <div className="transaction-review-progress__bar" style={{ width: `${progressPercent}%` }} />
                </div>
                <div className="transaction-review-progress__label">
                  {progressTotal === 0 ? 'No review items' : `${progressDone} of ${progressTotal} applied`}
                </div>

                {reviewRows.length ? (
                  <div className="merchant-review-table-wrap">
                    <div className="merchant-review-toolbar">
                      <div>
                        <strong>{reviewRows.length} merchants</strong>
                        <span>{selectedReviewRows.length} with categories selected</span>
                      </div>
                      <button
                        className="btn btn--primary btn--sm"
                        type="button"
                        disabled={isApplyingAiCategories || selectedReviewRows.length === 0}
                        onClick={applySelectedReviewRows}
                      >
                        {isApplyingAiCategories ? 'Applying...' : 'Apply batch'}
                      </button>
                    </div>
                    <table className="merchant-review-table">
                      <colgroup>
                        <col className="merchant-review-table__merchant" />
                        <col className="merchant-review-table__suggestion" />
                        <col className="merchant-review-table__volume" />
                        <col className="merchant-review-table__amount" />
                        <col className="merchant-review-table__category" />
                        <col className="merchant-review-table__action" />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>Merchant</th>
                          <th>AI suggestion</th>
                          <th className="num">Volume</th>
                          <th className="num">Amount</th>
                          <th>Category</th>
                          <th aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {reviewRows.map(row => {
                          const isExpanded = expandedReviewKey === row.key;
                          return (
                            <Fragment key={row.key}>
                              <tr
                                className={`merchant-review-row ${isExpanded ? 'is-expanded' : ''} ${!row.categoryId ? 'needs-category' : ''}`}
                                onClick={() => setExpandedReviewKey(isExpanded ? null : row.key)}
                              >
                                <td>
                                  <div className="merchant-review-row__name" title={row.merchantName}>{row.merchantName}</div>
                                  <div className="merchant-review-row__reason">{row.reason}</div>
                                </td>
                                <td><span className="merchant-review-chip">{getReviewRowLabel(row)}</span></td>
                                <td className="num">{row.transactionCount.toLocaleString()}</td>
                                <td className="num">{typeof row.totalAmount === 'number' ? formatCurrency(row.totalAmount, true) : '—'}</td>
                                <td onClick={(event) => event.stopPropagation()}>
                                  <select
                                    className="filter-input merchant-review-category-select"
                                    value={row.categoryId}
                                    onChange={(event) => setReviewCategory(row.key, event.target.value)}
                                  >
                                    <option value="">Choose category</option>
                                    {categories.map(category => (
                                      <option key={category.id} value={category.id}>{category.name}</option>
                                    ))}
                                  </select>
                                </td>
                                <td className="merchant-review-row__disclosure">
                                  <button
                                    className="merchant-review-expand-btn"
                                    type="button"
                                    aria-label={isExpanded ? 'Close merchant transactions' : 'Open merchant transactions'}
                                    aria-expanded={isExpanded}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setExpandedReviewKey(isExpanded ? null : row.key);
                                    }}
                                  >
                                    <ChevronRight size={15} />
                                  </button>
                                </td>
                              </tr>
                              {isExpanded && (
                                <tr className="merchant-review-details-row">
                                  <td colSpan={6}>
                                    <div className="merchant-review-details-panel">
                                      {renderTransactionPreview(row.transactions, row.transactionCount)}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="transaction-review-empty">
                    <h2>Review complete</h2>
                    <p>No remaining merchant suggestions or questions in this batch.</p>
                    <button className="btn btn--secondary btn--sm" type="button" onClick={handlePreviewAiCategorization}>
                      Run another batch
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="transaction-review-empty">
            <h2>Review uncategorized merchants</h2>
            <p>Run AI categorization to group uncategorized transactions by merchant and review suggested categories.</p>
            <button className="btn btn--primary btn--sm" type="button" onClick={handlePreviewAiCategorization}>
              Categorize with AI
            </button>
          </div>
        )}
      </div>

    </div>
  );
}
