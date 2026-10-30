import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { merchantReviewQueue, MerchantScope } from '../../../server/app/merchantReview';
import type { CategorySummary } from '../../../server/app/types';
import { trpc, trpcClient } from '../../api/trpc';
import { refreshCategoryData } from '../../api/categoryQueries';
import { formatCurrency, formatDate } from '../../utils/formatters';
import GroupedCategorySelect from '../shared/GroupedCategorySelect';
import type { useReviewedCategories } from '../transactions/ReviewedTransactions';
import TransactionContext from '../transactions/TransactionContext';

type Group = ReturnType<typeof merchantReviewQueue>['groups'][number];
type Changes = ReturnType<typeof useReviewedCategories>;

export default function MerchantReviewRow({
  group,
  categories,
  changes,
  onInspect,
}: {
  group: Group;
  categories: CategorySummary[];
  changes: Changes;
  onInspect: (id: string) => void;
}) {
  // Advice may arrive after mount. An explicit choice always wins over background updates.
  const [chosenCategory, setChosenCategory] = useState<string | null>(null);
  const categoryId =
    chosenCategory ?? (group.suggestion ? String(group.suggestion.categoryId) : '');
  const [panel, setPanel] = useState<'current' | 'history' | 'all' | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [primarySaved, setPrimarySaved] = useState(false);
  const [error, setError] = useState('');
  const [contextId, setContextId] = useState<string | null>(null);
  const contextPanelId = useId();
  const target = group.historyTargets.find((target) => target.categoryId === Number(categoryId));
  const detail = useQuery(
    trpc.categories.merchantScope.queryOptions(
      {
        groupId: group.id,
        scope: panel ?? 'current',
        categoryId: categoryId ? Number(categoryId) : undefined,
        offset,
      },
      { enabled: Boolean(panel) },
    ),
  );
  const blocked = busy || changes.pending;
  const historyScope = panel === 'history';
  const theseCount = historyScope ? (detail.data?.count ?? target?.count ?? 0) : group.reviewCount;
  const single = group.singleTransaction;
  const categoryName = categories.find((category) => String(category.id) === categoryId)?.name;
  const expanded = single ? Boolean(contextId) : Boolean(panel);
  const open = (value: typeof panel) => {
    setPanel(panel === value ? null : value);
    setOffset(0);
    setContextId(null);
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refreshCategoryData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = async (scope: MerchantScope) => {
    if (!categoryId) return;
    await run(async () => {
      const result = await trpcClient.categories.saveMerchant.mutate({
        groupId: group.id,
        scope,
        categoryId: Number(categoryId),
        fingerprint:
          scope === 'all'
            ? group.fingerprint
            : scope === 'current'
              ? group.primaryFingerprint
              : detail.data!.fingerprint,
      });
      changes.remember(result.undoOperation);
      setChosenCategory(categoryId);
      if (scope === 'current') setPrimarySaved(true);
      setPanel(null);
      setContextId(null);
    });
  };
  const keep = (scope: 'current' | 'history') =>
    run(async () => {
      await trpcClient.categories.keepMerchant.mutate({
        groupId: group.id,
        scope,
        categoryId: categoryId ? Number(categoryId) : undefined,
        fingerprint: scope === 'current' ? group.primaryFingerprint : detail.data!.fingerprint,
      });
      setPanel(null);
      setContextId(null);
    });
  return (
    <article className="merchant-review" aria-label={`${group.name} category review`}>
      <div className="merchant-review__row">
        <div>
          <button
            className="merchant-review__name merchant-review__disclosure"
            disabled={blocked}
            aria-expanded={expanded}
            onClick={() =>
              single
                ? setContextId(contextId ? null : single.id)
                : open(group.kept ? 'all' : 'current')
            }
          >
            <ChevronRight size={16} aria-hidden="true" />
            <span>{group.name}</span>
          </button>
          <p className="merchant-review__meta">
            {group.accountName} ·{' '}
            {single
              ? `${formatDate(single.date, 'medium')} · ${formatCurrency(single.amount, true)}`
              : group.kept
                ? `${group.transactionCount} reviewed transactions`
                : `${group.reviewCount} ${group.uncategorizedCount ? 'uncategorized' : 'to review'}`}
            {!single &&
              group.currentCount > 0 &&
              ` · ${formatCurrency(group.currentAmountCents / 100)} in activity`}
          </p>
          {group.categories.length > 0 && (
            <p className="merchant-review__meta">
              {group.movement ? 'Check money movement · Current: ' : 'Current: '}
              {group.categories.join(' · ')}
            </p>
          )}
        </div>
        {!group.kept && (
          <div className="merchant-review__category">
            <div
              className={`merchant-categorize${categoryName ? '' : ' merchant-categorize--empty'}`}
            >
              {categoryName ? (
                <button
                  type="button"
                  className="btn btn--primary merchant-categorize__apply"
                  disabled={
                    blocked ||
                    (primarySaved && !historyScope) ||
                    !theseCount ||
                    (historyScope && (!detail.data || detail.isFetching || Boolean(detail.error)))
                  }
                  title={
                    primarySaved && !historyScope
                      ? 'Current review entries categorized. Expand to review history.'
                      : `Categorize ${theseCount} ${historyScope ? 'earlier differing' : 'review'} transactions as ${categoryName}`
                  }
                  onClick={() => void save(historyScope ? 'history' : 'current')}
                >
                  {busy
                    ? 'Categorizing…'
                    : primarySaved && !historyScope
                      ? 'Categorized'
                      : `Categorize as ${categoryName}`}
                </button>
              ) : (
                <span className="merchant-categorize__placeholder">
                  {['idle', 'queued', 'running'].includes(group.recommendation?.status)
                    ? 'Finding category…'
                    : 'Choose category'}
                </span>
              )}
              <div className="merchant-categorize__selector">
                <ChevronDown size={16} aria-hidden="true" />
                <GroupedCategorySelect
                  categories={categories}
                  value={categoryId}
                  leadingOptions={[{ value: '', label: 'Choose category…' }]}
                  disabled={blocked}
                  aria-label={`Choose category for ${group.name}`}
                  onChange={(value) => {
                    setChosenCategory(value);
                    setPrimarySaved(false);
                    setOffset(0);
                  }}
                />
              </div>
            </div>
            {!primarySaved && chosenCategory === null && (
              <small title={group.suggestion?.reason || group.recommendation?.reason || undefined}>
                {group.suggestion?.source === 'ai'
                  ? 'AI suggestion'
                  : group.recommendation?.status === 'review'
                    ? 'Needs your context'
                    : group.recommendation?.status === 'unavailable'
                      ? 'AI unavailable'
                      : group.recommendation?.status === 'failed'
                        ? 'AI unavailable · '
                        : ''}
                {group.recommendation?.status === 'failed' && (
                  <button
                    className="merchant-review__retry"
                    disabled={blocked}
                    onClick={() =>
                      void run(() =>
                        trpcClient.categories.recommendMerchants.mutate({
                          groupIds: [group.id],
                          retry: true,
                        }),
                      )
                    }
                  >
                    Retry
                  </button>
                )}
              </small>
            )}
          </div>
        )}
        {group.kept && (
          <button
            className="btn btn--secondary btn--sm"
            disabled={blocked}
            onClick={() =>
              void run(() =>
                trpcClient.categories.reopenMerchant.mutate({
                  groupId: group.id,
                  fingerprint: group.fingerprint,
                }),
              )
            }
          >
            Reopen
          </button>
        )}
      </div>
      {Boolean(target?.count) && !group.kept && (group.currentCount > 0 || primarySaved) && (
        <button
          className="merchant-review__history-link"
          disabled={blocked}
          aria-expanded={panel === 'history'}
          onClick={() => open('history')}
        >
          {target!.count} earlier{' '}
          {target!.count === 1 ? 'transaction differs' : 'transactions differ'} ·{' '}
          {panel === 'history' ? 'Close' : 'Review'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {single && expanded && !group.kept && group.uncategorizedCount === 0 && (
        <button
          className="btn btn--ghost btn--sm"
          disabled={blocked}
          onClick={() => void keep('current')}
        >
          Keep current category
        </button>
      )}
      {panel && (
        <section
          className="merchant-review__details"
          aria-label={`${group.name} ${panel === 'history' ? 'earlier differences' : 'transactions'}`}
        >
          <header>
            <h3>
              {panel === 'history' ? 'Earlier category differences' : 'Transactions in this review'}
            </h3>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setPanel(null);
                setContextId(null);
              }}
            >
              Close
            </button>
          </header>
          {detail.isPending ? (
            <p role="status">Loading transactions…</p>
          ) : detail.error ? (
            <p role="alert">{detail.error.message}</p>
          ) : (
            detail.data && (
              <>
                <p className="merchant-review__meta">
                  {detail.data.count} transactions
                  {panel === 'history' && target
                    ? ` · ${target.matchingCount} earlier transactions already use ${categories.find((category) => category.id === Number(categoryId))?.name}`
                    : ''}
                </p>
                {!group.kept && group.transactionCount > 1 && (
                  <div className="merchant-review__all-action">
                    <button
                      className="btn btn--secondary"
                      disabled={blocked || !categoryId}
                      onClick={() => void save('all')}
                    >
                      Categorize all {group.transactionCount}
                      {categoryName ? ` as ${categoryName}` : '…'}
                    </button>
                    <span>Includes already-categorized history in {group.accountName}.</span>
                  </div>
                )}
                <ul className="merchant-review__transactions">
                  {detail.data.transactions.map((row) => (
                    <li key={row.ledgerTransactionId}>
                      <div className="merchant-review__context-row">
                        <span>{formatDate(row.date, 'medium')}</span>
                        <span>{row.category?.name ?? 'Uncategorized'}</span>
                        <strong>{formatCurrency(row.amount, true)}</strong>
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => onInspect(row.ledgerTransactionId!)}
                        >
                          Details
                        </button>
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() =>
                            setContextId(
                              contextId === row.ledgerTransactionId
                                ? null
                                : row.ledgerTransactionId,
                            )
                          }
                          aria-expanded={contextId === row.ledgerTransactionId}
                        >
                          Nearby activity
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                {(offset > 0 || detail.data.hasMore) && (
                  <div className="category-workspace__pagination">
                    <button
                      className="btn btn--ghost btn--sm"
                      disabled={offset === 0 || blocked}
                      onClick={() => setOffset(offset - 50)}
                    >
                      Previous
                    </button>
                    <span>
                      {offset + 1}–{offset + detail.data.transactions.length} of {detail.data.count}
                    </span>
                    <button
                      className="btn btn--ghost btn--sm"
                      disabled={!detail.data.hasMore || blocked}
                      onClick={() => setOffset(offset + 50)}
                    >
                      Next
                    </button>
                  </div>
                )}
                {panel === 'history' && detail.data.count > 0 && (
                  <div className="merchant-review__secondary">
                    <button
                      className="btn btn--ghost btn--sm"
                      disabled={blocked || detail.isFetching}
                      onClick={() => void keep('history')}
                    >
                      Keep these differences
                    </button>
                  </div>
                )}
                {panel !== 'history' && !group.kept && group.uncategorizedCount === 0 && (
                  <button
                    className="btn btn--ghost btn--sm"
                    disabled={blocked}
                    onClick={() => void keep('current')}
                  >
                    {group.conflict ? 'These differences are intentional' : 'Keep current category'}
                  </button>
                )}
                {group.reviewedCount > 0 && (
                  <button
                    className="btn btn--ghost btn--sm"
                    disabled={blocked}
                    onClick={() =>
                      void run(() =>
                        trpcClient.categories.reopenMerchant.mutate({
                          groupId: group.id,
                          fingerprint: group.fingerprint,
                        }),
                      )
                    }
                  >
                    Reopen intentional differences ({group.reviewedCount})
                  </button>
                )}
              </>
            )
          )}
        </section>
      )}
      {contextId && (
        <TransactionContext
          key={contextId}
          ledgerTransactionId={contextId}
          reviewIds={detail.data?.transactions.map((row) => row.ledgerTransactionId!) ?? []}
          panelId={contextPanelId}
        />
      )}
    </article>
  );
}
