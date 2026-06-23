import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
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
  const [aiQuestionCategoryByKey, setAiQuestionCategoryByKey] = useState({});
  const [ignoredAiQuestionKeys, setIgnoredAiQuestionKeys] = useState(new Set());
  const [currentReviewIndex, setCurrentReviewIndex] = useState(0);
  const [isAiCategorizing, setIsAiCategorizing] = useState(false);
  const [aiReviewStartedAt, setAiReviewStartedAt] = useState(null);
  const [aiReviewElapsedSeconds, setAiReviewElapsedSeconds] = useState(0);
  const [isApplyingAiCategories, setIsApplyingAiCategories] = useState(false);
  const [isSavingOpenAiKey, setIsSavingOpenAiKey] = useState(false);
  const { categories } = useCategories();

  const aiSuggestions = useMemo(() => aiCategorization?.suggestions ?? [], [aiCategorization?.suggestions]);
  const aiQuestions = useMemo(() => aiCategorization?.questions ?? [], [aiCategorization?.questions]);
  const activeAiQuestions = aiQuestions
    .map((question, index) => ({ ...question, key: `${question.pattern}-${index}` }))
    .filter(question => !ignoredAiQuestionKeys.has(question.key));
  const suggestionSelectionId = (suggestion) => suggestion.id ?? suggestion.transactionId;
  const suggestionTransactionIds = (suggestion) => suggestion.transactionIds ?? [suggestion.transactionId].filter(Boolean);
  const reviewItems = useMemo(() => [
    ...aiSuggestions
      .filter(suggestion => !suggestion.applied)
      .map(suggestion => ({ type: 'suggestion', id: suggestionSelectionId(suggestion), suggestion })),
    ...activeAiQuestions.map(question => ({ type: 'question', id: question.key, question })),
  ], [activeAiQuestions, aiSuggestions]);
  const boundedReviewIndex = reviewItems.length ? Math.min(currentReviewIndex, reviewItems.length - 1) : 0;
  const currentReviewItem = reviewItems[boundedReviewIndex] ?? null;

  useEffect(() => {
    if (!isAiCategorizing || !aiReviewStartedAt) return undefined;

    const intervalId = window.setInterval(() => {
      setAiReviewElapsedSeconds(Math.floor((Date.now() - aiReviewStartedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isAiCategorizing, aiReviewStartedAt]);

  const getSuggestionTransaction = (suggestion) => suggestion.transactions?.[0] || suggestion.transaction || null;
  const getQuestionTransactions = (question) => question.transactions ?? [];
  const getAiTransactionTitle = (transaction) => transaction?.merchant || transaction?.description || 'Transaction';
  const getAiTransactionSummary = (transaction) => {
    if (!transaction) return 'Transaction details unavailable';
    return `${getAiTransactionTitle(transaction)} · ${formatCurrency(transaction.amount, true)}`;
  };
  const getSuggestionEyebrow = (suggestion) => {
    if (suggestion.decisionKind === 'transfer') return 'Suggested transfer treatment';
    return 'Suggested category';
  };
  const formatTransactionCount = (count) => `${count.toLocaleString()} matching transaction${count === 1 ? '' : 's'}`;

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
      setAiQuestionCategoryByKey({});
      setIgnoredAiQuestionKeys(new Set());
      setCurrentReviewIndex(0);
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

  const showNextReviewItem = () => {
    setCurrentReviewIndex(index => Math.min(index + 1, reviewItems.length));
  };

  const handleApplyAiSuggestion = async (suggestion) => {
    if (!suggestion) return;

    setIsApplyingAiCategories(true);
    setAiCategorizationError('');
    try {
      const result = await trpcClient.transactions.applyAiCategorization.mutate({
        suggestions: suggestionTransactionIds(suggestion).map(transactionId => ({
          transactionId,
          categoryId: suggestion.categoryId,
        })),
      });
      const appliedIds = new Set(result.appliedTransactionIds ?? []);
      setAiCategorization(previous => previous ? {
        ...previous,
        suggestions: previous.suggestions.map(suggestion => suggestionTransactionIds(suggestion).some(transactionId => appliedIds.has(transactionId))
          ? { ...suggestion, applied: true }
          : suggestion),
        appliedCount: result.count,
        skippedCount: result.skipped?.length ?? 0,
      } : previous);
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

  const skipReviewItem = () => {
    if (currentReviewItem?.type === 'question') {
      ignoreAiQuestion(currentReviewItem.question.key);
      return;
    }
    showNextReviewItem();
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

  const progressTotal = reviewItems.length + (aiCategorization?.appliedCount ?? 0);
  const progressDone = progressTotal === 0 ? 0 : Math.min(progressTotal, boundedReviewIndex + (aiCategorization?.appliedCount ?? 0));
  const progressPercent = progressTotal === 0 ? 0 : Math.round((progressDone / progressTotal) * 100);

  return (
    <div className="page transaction-review-page">
      <div className="page__header transaction-review-page__header stagger-in">
        <div>
          <h1 className="page__title">Transaction Review</h1>
          <p className="transaction-review-page__subtitle">Review merchant-group suggestions before applying categories.</p>
        </div>
        <div className="transaction-review-page__actions">
          <Link className="btn btn--ghost btn--sm" to="/transactions">Back to transactions</Link>
          <button
            className="btn btn--secondary btn--sm"
            type="button"
            disabled={isAiCategorizing || isApplyingAiCategories}
            onClick={handlePreviewAiCategorization}
          >
            {isAiCategorizing ? 'Reviewing...' : aiCategorization ? 'Run again' : 'Categorize with AI'}
          </button>
        </div>
      </div>

      <div className="transaction-review-shell stagger-in">
        {(isAiCategorizing || aiCategorization || aiCategorizationError) ? (
          <>
            <div className="ai-category-status transaction-review-status">
              {isAiCategorizing && (
                <div className="ai-category-action__progress" role="status" aria-live="polite">
                  <div className="ai-category-action__progress-bar" aria-hidden="true" />
                  <span>Reviewing merchant groups with OpenAI. {aiReviewElapsedSeconds}s elapsed.</span>
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
                  <span>{aiCategorization.scanned} transactions scanned</span>
                  {typeof aiCategorization.groupCount === 'number' && (
                    <span>{aiCategorization.groupCount} merchant groups</span>
                  )}
                  {typeof aiCategorization.reviewedGroupCount === 'number' && (
                    <span>{aiCategorization.reviewedGroupCount} groups reviewed by AI</span>
                  )}
                  <span>{aiSuggestions.filter(suggestion => !suggestion.applied).length} suggestions</span>
                  <span>{activeAiQuestions.length} questions</span>
                  <span>{progressDone} of {progressTotal} reviewed</span>
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
                  {progressTotal === 0 ? 'No review items' : `${Math.min(progressDone + 1, progressTotal)} of ${progressTotal}`}
                </div>

                {currentReviewItem ? (
                  currentReviewItem.type === 'suggestion' ? (() => {
                    const suggestion = currentReviewItem.suggestion;
                    return (
                      <section className="transaction-review-card">
                        <div className="transaction-review-card__eyebrow">{getSuggestionEyebrow(suggestion)}</div>
                        <h2>
                          {suggestion.merchantName || getAiTransactionTitle(getSuggestionTransaction(suggestion))}
                        </h2>
                        <div className="transaction-review-card__category">{suggestion.categoryName}</div>
                        <p>{suggestion.reason}</p>
                        <div className="transaction-review-card__meta">
                          <span>
                            {suggestion.transactionCount
                              ? formatTransactionCount(suggestion.transactionCount)
                              : getAiTransactionSummary(getSuggestionTransaction(suggestion))}
                          </span>
                          {suggestion.transactionCount && <span>{formatCurrency(suggestion.totalAmount, true)}</span>}
                        </div>
                        {renderTransactionPreview(
                          suggestion.transactions ?? (getSuggestionTransaction(suggestion) ? [getSuggestionTransaction(suggestion)] : []),
                          suggestion.transactionCount ?? suggestionTransactionIds(suggestion).length
                        )}
                        <div className="transaction-review-card__actions">
                          <button className="btn btn--ghost" type="button" onClick={skipReviewItem}>Skip</button>
                          <button
                            className="btn btn--primary"
                            type="button"
                            disabled={isApplyingAiCategories}
                            onClick={() => handleApplyAiSuggestion(suggestion)}
                          >
                            {isApplyingAiCategories ? 'Applying...' : 'Accept'}
                          </button>
                        </div>
                      </section>
                    );
                  })() : (() => {
                    const question = currentReviewItem.question;
                    return (
                      <section className="transaction-review-card">
                        <div className="transaction-review-card__eyebrow">Needs your call</div>
                        <h2>{question.pattern}</h2>
                        <p>{question.reason}</p>
                        <div className="transaction-review-card__meta">
                          <span>{formatTransactionCount(question.transactionIds.length)}</span>
                          {typeof question.totalAmount === 'number' && <span>{formatCurrency(question.totalAmount, true)}</span>}
                        </div>
                        {renderTransactionPreview(getQuestionTransactions(question), question.transactionIds.length)}
                        <div className="transaction-review-card__picker">
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
                        </div>
                        <div className="transaction-review-card__actions">
                          <button className="btn btn--ghost" type="button" onClick={skipReviewItem}>Skip</button>
                          <button
                            type="button"
                            className="btn btn--primary"
                            disabled={!aiQuestionCategoryByKey[question.key] || isApplyingAiCategories}
                            onClick={() => applyAiQuestion(question)}
                          >
                            {isApplyingAiCategories ? 'Applying...' : 'Apply'}
                          </button>
                        </div>
                      </section>
                    );
                  })()
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
