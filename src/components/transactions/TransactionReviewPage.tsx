import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ChevronRight, X } from 'lucide-react';
import { useCategories } from '../../hooks/useCategories';
import { formatCurrency } from '../../utils/formatters';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import GroupedCategorySelect from '../shared/GroupedCategorySelect';
import './TransactionsPage.css';

const AI_CATEGORIZATION_GROUP_LIMIT = 32;
const AI_CATEGORIZATION_TIMEOUT_MS = 90_000;
const AI_REVIEW_SORT_STORAGE_KEY = 'easymoney:transaction-review-sort';
const AI_SORT_OPTIONS = [
  { value: 'count', label: 'Count' },
  { value: 'money', label: 'Money' },
] as const;

type AiReviewSort = typeof AI_SORT_OPTIONS[number]['value'];
type SplitStrategy = 'bank_description_counterparty' | 'individual_transactions';

interface AiReviewTransaction {
  transactionId: string;
  account?: string | null;
  date?: string | null;
  amount: number;
  merchant?: string | null;
  description?: string | null;
  sourceRole?: string | null;
}

interface AiSuggestion {
  id?: string;
  transactionId?: string;
  transactionIds?: string[];
  transaction?: AiReviewTransaction | null;
  transactions?: AiReviewTransaction[];
  transactionCount?: number;
  totalAmount?: number | null;
  merchantName?: string | null;
  reason?: string | null;
  decisionKind?: string | null;
  sourceMerchantKey?: string | null;
  canSplitMerchantGroup?: boolean;
  recommendedSplitStrategy?: SplitStrategy | null;
  accountNames?: string[];
  categoryId: string | number;
  applied?: boolean;
}

interface AiQuestion {
  key?: string;
  groupId?: string | null;
  pattern: string;
  transactionIds: string[];
  transactions?: AiReviewTransaction[];
  transactionCount?: number;
  totalAmount?: number | null;
  reason?: string | null;
  decisionKind?: string | null;
  sourceMerchantKey?: string | null;
  canSplitMerchantGroup?: boolean;
  recommendedSplitStrategy?: SplitStrategy | null;
  accountNames?: string[];
}

interface AiCategorizationPreview {
  configured?: boolean;
  model?: string | null;
  scanned?: number;
  groupCount?: number;
  suggestions: AiSuggestion[];
  questions: AiQuestion[];
  message?: string | null;
  appliedCount?: number;
  skippedCount?: number;
}

interface AiCategoryUndo {
  id: string | number;
  count: number;
}

interface AutoApplyJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | string;
  message?: string | null;
  groupCount: number;
  reviewedGroupCount: number;
  suggestedGroupCount: number;
  appliedCount?: number;
  skippedCount?: number;
  error?: string | null;
  undoOperation?: AiCategoryUndo | null;
}

interface ReviewQuestion extends AiQuestion {
  key: string;
}

interface ReviewRow {
  type: 'suggestion' | 'question';
  key: string;
  merchantName: string;
  transactionIds: string[];
  transactionCount: number;
  totalAmount?: number | null;
  reason?: string | null;
  decisionKind?: string | null;
  sourceMerchantKey?: string | null;
  canSplitMerchantGroup?: boolean;
  recommendedSplitStrategy?: SplitStrategy | null;
  accountName: string;
  suggestedCategoryId: string;
  categoryId: string;
  transactions: AiReviewTransaction[];
}

interface CategorizationCoverage {
  transactionPercent: number;
  amountPercent: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }) as Promise<T>;
}

function getInitialAiReviewSort(): AiReviewSort {
  try {
    const storedSort = window.localStorage.getItem(AI_REVIEW_SORT_STORAGE_KEY);
    return storedSort === 'money' ? 'money' : 'count';
  } catch {
    return 'count';
  }
}

export default function TransactionReviewPage() {
  const hasStartedReview = useRef(false);
  const [aiCategorization, setAiCategorization] = useState<AiCategorizationPreview | null>(null);
  const [aiCategorizationError, setAiCategorizationError] = useState('');
  const [openAiApiKeyDraft, setOpenAiApiKeyDraft] = useState('');
  const [ignoredAiQuestionKeys, setIgnoredAiQuestionKeys] = useState<Set<string>>(() => new Set());
  const [categoryByReviewKey, setCategoryByReviewKey] = useState<Record<string, string>>({});
  const [expandedReviewKey, setExpandedReviewKey] = useState<string | null>(null);
  const aiPreviewRequestId = useRef(0);
  const [isAiCategorizing, setIsAiCategorizing] = useState(false);
  const [aiReviewStartedAt, setAiReviewStartedAt] = useState<number | null>(null);
  const [aiReviewElapsedSeconds, setAiReviewElapsedSeconds] = useState(0);
  const [isApplyingAiCategories, setIsApplyingAiCategories] = useState(false);
  const [isAutoApplyingAiCategories, setIsAutoApplyingAiCategories] = useState(false);
  const [autoApplyJob, setAutoApplyJob] = useState<AutoApplyJob | null>(null);
  const [aiCategoryUndo, setAiCategoryUndo] = useState<AiCategoryUndo | null>(null);
  const [isRestoringAiCategories, setIsRestoringAiCategories] = useState(false);
  const [splitByReviewKey, setSplitByReviewKey] = useState<Record<string, boolean>>({});
  const [isSavingOpenAiKey, setIsSavingOpenAiKey] = useState(false);
  const [aiReviewSort, setAiReviewSort] = useState(getInitialAiReviewSort);
  const { categories } = useCategories();
  const categorizationCoverage = useQuery(trpc.transactions.categorizationCoverage.queryOptions());

  const getSuggestionTransaction = (suggestion: AiSuggestion) => suggestion.transactions?.[0] || suggestion.transaction || null;
  const getQuestionTransactions = (question: AiQuestion) => question.transactions ?? [];
  const getAiTransactionTitle = (transaction?: AiReviewTransaction | null) => transaction?.merchant || transaction?.description || 'Transaction';
  const getSourceRoleLabel = (sourceRole?: string | null) => {
    if (sourceRole === 'statement-summary') return 'Statement summary';
    if (sourceRole === 'statement-only') return 'Statement only';
    return '';
  };
  const aiSuggestions = useMemo(() => aiCategorization?.suggestions ?? [], [aiCategorization?.suggestions]);
  const aiQuestions = useMemo(() => aiCategorization?.questions ?? [], [aiCategorization?.questions]);
  const activeAiQuestions = useMemo<ReviewQuestion[]>(() => aiQuestions
    .map((question, index) => ({ ...question, key: `${question.groupId || question.pattern}-${index}` }))
    .filter(question => !ignoredAiQuestionKeys.has(question.key)), [aiQuestions, ignoredAiQuestionKeys]);
  const suggestionSelectionId = (suggestion: AiSuggestion) => suggestion.id ?? suggestion.transactionId ?? '';
  const suggestionTransactionIds = (suggestion: AiSuggestion) => suggestion.transactionIds ?? [suggestion.transactionId].filter((id): id is string => Boolean(id));
  const reviewRows = useMemo<ReviewRow[]>(() => {
    const suggestionRows: ReviewRow[] = aiSuggestions
      .filter(suggestion => !suggestion.applied)
      .map(suggestion => {
        const transaction = getSuggestionTransaction(suggestion);
        const transactionIds = suggestionTransactionIds(suggestion);
        return {
          type: 'suggestion',
          key: suggestionSelectionId(suggestion),
          merchantName: suggestion.merchantName || getAiTransactionTitle(transaction),
          transactionIds,
          transactionCount: suggestion.transactionCount ?? transactionIds.length,
          totalAmount: suggestion.totalAmount,
          reason: suggestion.reason,
          decisionKind: suggestion.decisionKind,
          sourceMerchantKey: suggestion.sourceMerchantKey,
          canSplitMerchantGroup: suggestion.canSplitMerchantGroup,
          recommendedSplitStrategy: suggestion.recommendedSplitStrategy,
          accountName: suggestion.accountNames?.length === 1 ? suggestion.accountNames[0] : '',
          suggestedCategoryId: String(suggestion.categoryId),
          categoryId: categoryByReviewKey[suggestionSelectionId(suggestion)] ?? String(suggestion.categoryId),
          transactions: suggestion.transactions ?? (transaction ? [transaction] : []),
        };
      });
    const questionRows: ReviewRow[] = activeAiQuestions.map(question => ({
      type: 'question',
      key: question.key,
      merchantName: question.pattern,
      transactionIds: question.transactionIds,
      transactionCount: question.transactionCount ?? question.transactionIds.length,
      totalAmount: question.totalAmount,
      reason: question.reason,
      decisionKind: question.decisionKind,
      sourceMerchantKey: question.sourceMerchantKey,
      canSplitMerchantGroup: question.canSplitMerchantGroup,
      recommendedSplitStrategy: question.recommendedSplitStrategy,
      accountName: question.accountNames?.length === 1 ? question.accountNames[0] : '',
      suggestedCategoryId: '',
      categoryId: categoryByReviewKey[question.key] ?? '',
      transactions: getQuestionTransactions(question),
    }));
    const rows = [...suggestionRows, ...questionRows];

    return rows.sort((a, b) => {
      if (aiReviewSort === 'money') {
        return Math.abs(b.totalAmount ?? 0) - Math.abs(a.totalAmount ?? 0) ||
          b.transactionCount - a.transactionCount ||
          a.merchantName.localeCompare(b.merchantName);
      }

      return b.transactionCount - a.transactionCount ||
        Math.abs(b.totalAmount ?? 0) - Math.abs(a.totalAmount ?? 0) ||
        a.merchantName.localeCompare(b.merchantName);
    });
  }, [activeAiQuestions, aiReviewSort, aiSuggestions, categoryByReviewKey]);
  const selectedReviewRows = reviewRows.filter(row => row.categoryId && row.transactionIds.length);
  const splitReviewRows = reviewRows.filter((row): row is ReviewRow & { sourceMerchantKey: string } => Boolean(splitByReviewKey[row.key] && row.sourceMerchantKey));
  const categoryReviewRows = selectedReviewRows.filter(row => !splitByReviewKey[row.key]);
  const actionableReviewRowCount = categoryReviewRows.length + splitReviewRows.length;

  useEffect(() => {
    if (!isAiCategorizing || !aiReviewStartedAt) return undefined;

    const intervalId = window.setInterval(() => {
      setAiReviewElapsedSeconds(Math.floor((Date.now() - aiReviewStartedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isAiCategorizing, aiReviewStartedAt]);

  const renderTransactionPreview = (transactions: AiReviewTransaction[], totalCount: number) => {
    const rows = transactions ?? [];
    if (!rows.length) return null;

    return (
      <div className="transaction-review-card__transactions">
        {rows.map(transaction => (
          <div className="transaction-review-card__transaction" key={transaction.transactionId}>
            <div>
              <strong>{getAiTransactionTitle(transaction)}</strong>
              <span>
                {transaction.account || 'Unknown account'} · {transaction.date}
                {getSourceRoleLabel(transaction.sourceRole) && (
                  <em className="transaction-review-card__source-role">
                    {getSourceRoleLabel(transaction.sourceRole)}
                  </em>
                )}
              </span>
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

  const handlePreviewAiCategorization = useCallback(async (sortOverride: AiReviewSort = aiReviewSort) => {
    const sort = sortOverride === 'money' ? 'money' : 'count';
    const requestId = aiPreviewRequestId.current + 1;
    aiPreviewRequestId.current = requestId;
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
      message: `Reviewing ${AI_CATEGORIZATION_GROUP_LIMIT} merchant groups by ${sort === 'money' ? 'money' : 'count'}...`,
    });
    try {
      const result = await withTimeout(
        trpcClient.transactions.aiCategorizationPreview.mutate({
          limit: AI_CATEGORIZATION_GROUP_LIMIT,
          sort,
        }),
        AI_CATEGORIZATION_TIMEOUT_MS,
        `AI categorization took longer than ${Math.round(AI_CATEGORIZATION_TIMEOUT_MS / 1000)} seconds. Try again with fewer uncategorized transactions or check the server logs.`
      );
      if (aiPreviewRequestId.current !== requestId) return;
      setAiCategorization(result as AiCategorizationPreview);
      setCategoryByReviewKey({});
      setSplitByReviewKey({});
      setIgnoredAiQuestionKeys(new Set());
      setExpandedReviewKey(null);
    } catch (error) {
      if (aiPreviewRequestId.current !== requestId) return;
      setAiCategorization(null);
      setAiCategorizationError(error instanceof Error ? error.message : String(error));
    } finally {
      if (aiPreviewRequestId.current === requestId) {
        setIsAiCategorizing(false);
        setAiReviewStartedAt(null);
      }
    }
  }, [aiReviewSort]);

  useEffect(() => {
    if (!autoApplyJob?.id || !['queued', 'running'].includes(autoApplyJob.status)) return undefined;

    let cancelled = false;
    const pollJob = async () => {
      try {
        const nextJob = await trpcClient.transactions.autoApplyAiCategorizationJob.query({
          jobId: autoApplyJob.id,
        }) as AutoApplyJob;
        if (cancelled) return;
        setAutoApplyJob(nextJob);

        if (nextJob.status === 'completed') {
          setIsAutoApplyingAiCategories(false);
          setAiCategoryUndo(nextJob.undoOperation ?? null);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() }),
            queryClient.invalidateQueries({ queryKey: trpc.transactions.categorizationCoverage.queryKey() }),
            queryClient.invalidateQueries({ queryKey: ['app', 'transactions', 'infinite'] }),
          ]);
          await handlePreviewAiCategorization();
          if (!cancelled) {
            setAiCategorization(previous => previous ? {
              ...previous,
              appliedCount: nextJob.appliedCount,
              skippedCount: nextJob.skippedCount,
              message: nextJob.message,
            } : previous);
          }
        } else if (nextJob.status === 'failed') {
          setIsAutoApplyingAiCategories(false);
          setAiCategorizationError(nextJob.error || 'AI auto-apply failed.');
        }
      } catch (error) {
        if (cancelled) return;
        setIsAutoApplyingAiCategories(false);
        setAiCategorizationError(error instanceof Error ? error.message : String(error));
      }
    };

    void pollJob();
    const intervalId = window.setInterval(() => {
      void pollJob();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [autoApplyJob?.id, autoApplyJob?.status, handlePreviewAiCategorization]);

  const handleAiReviewSortChange = (sort: AiReviewSort) => {
    if (sort === aiReviewSort && isAiCategorizing) return;
    try {
      window.localStorage.setItem(AI_REVIEW_SORT_STORAGE_KEY, sort);
    } catch {
      // Ignore storage failures; the selected sort still applies for this session.
    }
    setAiReviewSort(sort);
    if (isAiCategorizing || aiCategorization || aiCategorizationError) {
      void handlePreviewAiCategorization(sort);
    }
  };

  useEffect(() => {
    if (hasStartedReview.current) return;
    hasStartedReview.current = true;
    void handlePreviewAiCategorization();
  }, [handlePreviewAiCategorization]);

  const setReviewCategory = (reviewKey: string, categoryId: string) => {
    setCategoryByReviewKey(previous => ({
      ...previous,
      [reviewKey]: categoryId,
    }));
  };

  const setReviewSplit = (reviewKey: string, shouldSplit: boolean) => {
    setSplitByReviewKey(previous => {
      const next = { ...previous };
      if (shouldSplit) {
        next[reviewKey] = true;
      } else {
        delete next[reviewKey];
      }
      return next;
    });
  };

  const applySelectedReviewRows = async () => {
    if (!actionableReviewRowCount) return;

    setIsApplyingAiCategories(true);
    setAiCategorizationError('');
    try {
      await Promise.all(splitReviewRows.map(row =>
        trpcClient.transactions.createMerchantGroupingRule.mutate({
          sourceMerchantKey: row.sourceMerchantKey,
          strategy: row.recommendedSplitStrategy || 'individual_transactions',
        })
      ));

      const result = categoryReviewRows.length
        ? await trpcClient.transactions.applyAiCategorization.mutate({
          suggestions: categoryReviewRows.flatMap(row => row.transactionIds.map(transactionId => ({
            transactionId,
            categoryId: row.categoryId,
          }))),
        })
        : {
          count: 0,
          appliedTransactionIds: [],
          skipped: [],
          undoOperation: null,
        } as {
          count: number;
          appliedTransactionIds: string[];
          skipped: unknown[];
          undoOperation: AiCategoryUndo | null;
        };
      const appliedIds = new Set(result.appliedTransactionIds ?? []);
      const appliedQuestionKeys = new Set(
        categoryReviewRows
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
      setAiCategoryUndo(result.undoOperation ?? null);
      if (appliedQuestionKeys.size > 0) {
        setIgnoredAiQuestionKeys(previous => new Set([...previous, ...appliedQuestionKeys]));
      }
      setSplitByReviewKey({});
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.transactions.categorizationCoverage.queryKey() }),
        queryClient.invalidateQueries({ queryKey: ['app', 'transactions', 'infinite'] }),
      ]);
      await handlePreviewAiCategorization();
    } catch (error) {
      setAiCategorizationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsApplyingAiCategories(false);
    }
  };

  const autoApplyConfidentAiCategories = async () => {
    setIsAutoApplyingAiCategories(true);
    setAiCategorizationError('');
    setAutoApplyJob(null);
    try {
      const job = await trpcClient.transactions.startAutoApplyAiCategorization.mutate({ sort: aiReviewSort }) as AutoApplyJob;
      setAutoApplyJob(job);
      setAiCategorization(previous => previous ? {
        ...previous,
        message: job.message,
      } : previous);
    } catch (error) {
      setIsAutoApplyingAiCategories(false);
      setAiCategorizationError(error instanceof Error ? error.message : String(error));
    }
  };

  const restoreAiCategoryBatch = async () => {
    if (!aiCategoryUndo) return;
    setIsRestoringAiCategories(true);
    setAiCategorizationError('');
    try {
      await trpcClient.transactions.restoreCategories.mutate({
        undoOperationId: aiCategoryUndo.id,
      });
      setAiCategoryUndo(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.transactions.categorizationCoverage.queryKey() }),
        queryClient.invalidateQueries({ queryKey: ['app', 'transactions', 'infinite'] }),
      ]);
      await handlePreviewAiCategorization();
    } catch (error) {
      setAiCategorizationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRestoringAiCategories(false);
    }
  };

  const handleSaveOpenAiKey = async (event: FormEvent<HTMLFormElement>) => {
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

  const formatPercent = (value: number) => value.toLocaleString('en-US', {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: value > 0 && value < 0.01 ? 1 : 0,
  });
  const coverage = categorizationCoverage.data as CategorizationCoverage | undefined;
  const aiAppliedCount = aiCategorization?.appliedCount ?? 0;
  const aiSkippedCount = aiCategorization?.skippedCount ?? 0;

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
          <div className="transaction-review-header-actions">
            <div className="transaction-review-sort" aria-label="AI review sort">
              {AI_SORT_OPTIONS.map(option => (
                <button
                  key={option.value}
                  className={`transaction-review-sort__button ${aiReviewSort === option.value ? 'is-active' : ''}`}
                  type="button"
                  aria-pressed={aiReviewSort === option.value}
                  disabled={isApplyingAiCategories}
                  onClick={() => handleAiReviewSortChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {!isAiCategorizing && aiCategorizationError && (
              <button
                className="btn btn--secondary btn--sm"
                type="button"
                disabled={isApplyingAiCategories}
                onClick={() => handlePreviewAiCategorization()}
              >
                Retry
              </button>
            )}
          </div>
          {coverage && (
            <section className="transaction-review-coverage" aria-label="Categorization coverage">
              <div className="transaction-review-coverage__item">
                <div className="transaction-review-coverage__label">
                  <span>Transactions</span>
                  <strong>{formatPercent(coverage.transactionPercent)}</strong>
                </div>
                <div className="transaction-review-coverage__bar" aria-hidden="true">
                  <span style={{ width: `${Math.round(coverage.transactionPercent * 100)}%` }} />
                </div>
              </div>
              <div className="transaction-review-coverage__item">
                <div className="transaction-review-coverage__label">
                  <span>Money</span>
                  <strong>{formatPercent(coverage.amountPercent)}</strong>
                </div>
                <div className="transaction-review-coverage__bar" aria-hidden="true">
                  <span style={{ width: `${Math.round(coverage.amountPercent * 100)}%` }} />
                </div>
              </div>
            </section>
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
              {autoApplyJob && ['queued', 'running'].includes(autoApplyJob.status) && (
                <div className="ai-category-action__progress" role="status" aria-live="polite">
                  <div className="ai-category-action__progress-bar" aria-hidden="true" />
                  <span>
                    {autoApplyJob.message || 'Auto-applying confident categories...'}
                    {' '}
                    {autoApplyJob.groupCount > 0 && (
                      <>
                        {autoApplyJob.reviewedGroupCount.toLocaleString()} / {autoApplyJob.groupCount.toLocaleString()} groups reviewed,
                        {' '}
                        {autoApplyJob.suggestedGroupCount.toLocaleString()} confident
                      </>
                    )}
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
              {!isAiCategorizing && aiCategorization?.message && aiCategorization.configured !== false && (
                <p className="ai-category-action__message">{aiCategorization.message}</p>
              )}
              {aiAppliedCount > 0 && (
                <p className="ai-category-action__message">
                  Applied {aiAppliedCount} category updates.
                  {aiSkippedCount > 0 ? ` Skipped ${aiSkippedCount} already-categorized or missing transactions.` : ''}
                </p>
              )}
              {aiCategoryUndo && (
                <div className="ai-category-action__undo" role="status" aria-live="polite">
                  <span>
                    Applied {aiCategoryUndo.count.toLocaleString()} update{aiCategoryUndo.count === 1 ? '' : 's'}.
                  </span>
                  <button
                    className="btn btn--secondary btn--sm"
                    type="button"
                    disabled={isRestoringAiCategories || isApplyingAiCategories}
                    onClick={restoreAiCategoryBatch}
                  >
                    {isRestoringAiCategories ? 'Undoing...' : 'Undo'}
                  </button>
                  <button
                    className="transaction-feedback-dismiss"
                    type="button"
                    aria-label="Dismiss categorization update"
                    disabled={isRestoringAiCategories}
                    onClick={() => setAiCategoryUndo(null)}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              {aiCategorizationError && (
                <p className="ai-category-action__error">{aiCategorizationError}</p>
              )}
            </div>

            {aiCategorization?.configured && (aiSuggestions.length > 0 || aiQuestions.length > 0) && (
              <div className="transaction-review-deck">
                {reviewRows.length ? (
                  <div className="merchant-review-table-wrap">
                    <div className="merchant-review-toolbar">
                      <div>
                        <strong>{reviewRows.length} merchants</strong>
                        <span>
                          {categoryReviewRows.length} with categories selected
                          {splitReviewRows.length > 0 ? ` · ${splitReviewRows.length} to split` : ''}
                        </span>
                      </div>
                  <button
                    className="btn btn--secondary btn--sm"
                    type="button"
                    disabled={isApplyingAiCategories || isAutoApplyingAiCategories || isAiCategorizing}
                    onClick={autoApplyConfidentAiCategories}
                  >
                    {isAutoApplyingAiCategories ? 'Auto-applying...' : 'Do the rest with AI'}
                  </button>
                  <button
                    className="btn btn--primary btn--sm"
                    type="button"
                    disabled={isApplyingAiCategories || isAutoApplyingAiCategories || actionableReviewRowCount === 0}
                    onClick={applySelectedReviewRows}
                  >
                        {isApplyingAiCategories ? 'Applying...' : 'Apply batch'}
                      </button>
                    </div>
                    <table className="merchant-review-table">
                      <colgroup>
                        <col className="merchant-review-table__category" />
                        <col className="merchant-review-table__merchant" />
                        <col className="merchant-review-table__volume" />
                        <col className="merchant-review-table__amount" />
                        <col className="merchant-review-table__action" />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>Category</th>
                          <th>Merchant</th>
                          <th className="num">Volume</th>
                          <th className="num">Amount</th>
                          <th aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {reviewRows.map(row => {
                          const isExpanded = expandedReviewKey === row.key;
                          const isUsingAiSuggestion = row.type === 'suggestion' && row.categoryId === row.suggestedCategoryId;
                          return (
                            <Fragment key={row.key}>
                              <tr
                                className={`merchant-review-row ${isExpanded ? 'is-expanded' : ''} ${!row.categoryId ? 'needs-category' : ''}`}
                                onClick={() => setExpandedReviewKey(isExpanded ? null : row.key)}
                              >
                                <td onClick={(event) => event.stopPropagation()}>
                                  <GroupedCategorySelect
                                    className="filter-input merchant-review-category-select"
                                    controlClassName="merchant-review-category-control"
                                    value={row.categoryId}
                                    categories={categories}
                                    leadingOptions={[{ value: '', label: '' }]}
                                    suggestedCategoryId={row.suggestedCategoryId}
                                    showSuggestionIcon={isUsingAiSuggestion}
                                    onChange={(value) => setReviewCategory(row.key, value)}
                                  />
                                </td>
                                <td>
                                  <div className="merchant-review-row__name" title={row.merchantName}>
                                    <span>{row.merchantName}</span>
                                    {row.accountName && <span className="merchant-review-account-badge">{row.accountName}</span>}
                                  </div>
                                  <div className="merchant-review-row__reason">{row.reason}</div>
                                </td>
                                <td className="num">{row.transactionCount.toLocaleString()}</td>
                                <td className="num">{typeof row.totalAmount === 'number' ? formatCurrency(row.totalAmount, true) : '—'}</td>
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
                                  <td colSpan={5}>
                                    <div className="merchant-review-details-panel">
                                      {row.canSplitMerchantGroup && (
                                        <label className="merchant-review-split-choice">
                                          <input
                                            type="checkbox"
                                            checked={Boolean(splitByReviewKey[row.key])}
                                            disabled={isAiCategorizing || isApplyingAiCategories}
                                            onChange={(event) => setReviewSplit(row.key, event.target.checked)}
                                          />
                                          <span>
                                            {row.recommendedSplitStrategy === 'bank_description_counterparty'
                                              ? 'Split by counterparty'
                                              : 'Handle separately'}
                                          </span>
                                        </label>
                                      )}
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
                    <p>No remaining merchant suggestions or questions.</p>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="transaction-review-empty">
            <h2>Starting review...</h2>
          </div>
        )}
      </div>

    </div>
  );
}
