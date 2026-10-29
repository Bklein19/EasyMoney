import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { merchantReviewQueue, MerchantScope } from '../../../server/app/merchantReview';
import type { CategorySummary } from '../../../server/app/types';
import { trpc, trpcClient, queryClient } from '../../api/trpc';
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
  const [categoryId, setCategoryId] = useState(
    group.suggestion ? String(group.suggestion.categoryId) : '',
  );
  const [panel, setPanel] = useState<'current' | 'history' | 'all' | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
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
      await queryClient.invalidateQueries();
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
            className="merchant-review__name"
            disabled={blocked}
            aria-expanded={
              single ? contextId === single.id : panel === 'current' || panel === 'all'
            }
            onClick={() =>
              single
                ? setContextId(contextId ? null : single.id)
                : open(group.kept ? 'all' : 'current')
            }
          >
            {group.name}
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
            <GroupedCategorySelect
              categories={categories}
              value={categoryId}
              leadingOptions={[{ value: '', label: 'Choose category…' }]}
              disabled={blocked}
              aria-label={`Category for ${group.name}`}
              onChange={(value) => {
                setCategoryId(value);
                setOffset(0);
              }}
            />
            {group.suggestion && categoryId === String(group.suggestion.categoryId) && (
              <small title={group.suggestion.reason}>Suggested from source / saved history</small>
            )}
          </div>
        )}
        {!group.kept && (
          <div className="merchant-review__actions">
            <button
              className="btn btn--primary btn--sm"
              disabled={
                blocked ||
                !categoryId ||
                !theseCount ||
                (historyScope && (!detail.data || detail.isFetching || Boolean(detail.error)))
              }
              onClick={() => void save(historyScope ? 'history' : 'current')}
            >
              {busy ? 'Saving…' : `Categorize these ${theseCount}`}
            </button>
            {group.transactionCount > theseCount && (
              <button
                className="btn btn--secondary btn--sm"
                disabled={blocked || !categoryId}
                title={`All transactions in this merchant group in ${group.accountName}, including already-categorized history`}
                onClick={() => void save('all')}
              >
                Categorize all {group.transactionCount}
              </button>
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
      <div className="merchant-review__secondary">
        {single && (
          <button
            className="btn btn--ghost btn--sm"
            aria-expanded={Boolean(contextId)}
            onClick={() => setContextId(contextId ? null : single.id)}
          >
            Nearby activity
          </button>
        )}
        {!group.kept && group.uncategorizedCount === 0 && (
          <>
            {!single && (
              <button
                className="btn btn--ghost btn--sm"
                disabled={blocked}
                onClick={() => open('current')}
              >
                Review {group.reviewCount}
              </button>
            )}
            <button
              className="btn btn--ghost btn--sm"
              disabled={blocked}
              onClick={() => void keep('current')}
            >
              {group.conflict ? 'These differences are intentional' : 'Keep current category'}
            </button>
          </>
        )}
      </div>
      {Boolean(target?.count) && !group.kept && (
        <button
          className="merchant-review__history-link"
          disabled={blocked}
          aria-expanded={panel === 'history'}
          onClick={() => open('history')}
        >
          {target!.count} earlier transactions differ · {panel === 'history' ? 'Close' : 'Review'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
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
