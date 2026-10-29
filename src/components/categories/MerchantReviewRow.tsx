import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { merchantReviewQueue } from '../../../server/app/merchantReview';
import type { CategorySummary, TransactionListItem } from '../../../server/app/types';
import { trpc, trpcClient, queryClient } from '../../api/trpc';
import { formatCurrency, formatDate } from '../../utils/formatters';
import GroupedCategorySelect from '../shared/GroupedCategorySelect';
import type { useReviewedCategories } from '../transactions/ReviewedTransactions';
import TransactionContext from '../transactions/TransactionContext';

type Group = ReturnType<typeof merchantReviewQueue>['groups'][number];
type Changes = ReturnType<typeof useReviewedCategories>;

function IndividualCategory({
  row,
  categories,
  changes,
}: {
  row: TransactionListItem;
  categories: CategorySummary[];
  changes: Changes;
}) {
  const [value, setValue] = useState(String(row.category?.id ?? ''));
  return (
    <div className="merchant-review__individual">
      <span>
        {formatDate(row.date, 'medium')} · {formatCurrency(row.amount, true)}
      </span>
      <GroupedCategorySelect
        categories={categories}
        value={value}
        leadingOptions={[{ value: '', label: 'Choose category…' }]}
        aria-label={`Category for ${row.merchant} on ${row.date} (${row.ledgerTransactionId})`}
        onChange={setValue}
        disabled={changes.pending}
      />
      <button
        className="btn btn--secondary btn--sm"
        disabled={changes.pending || !value || Number(value) === row.category?.id}
        onClick={() => void changes.apply([row], Number(value), 'Individual merchant correction')}
      >
        Save
      </button>
    </div>
  );
}

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
  const save = async (scope: 'current' | 'history') => {
    if (!categoryId) return;
    await run(async () => {
      const result = await trpcClient.categories.saveMerchant.mutate({
        groupId: group.id,
        scope,
        categoryId: Number(categoryId),
        fingerprint: scope === 'current' ? group.primaryFingerprint : detail.data!.fingerprint,
      });
      changes.remember(result.undoOperation);
      setPanel(null);
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
    });
  return (
    <article className="merchant-review" aria-label={`${group.name} category review`}>
      <div className="merchant-review__row">
        <div>
          <button
            className="merchant-review__name"
            disabled={blocked}
            aria-expanded={panel === 'current' || panel === 'all'}
            onClick={() => open(group.kept ? 'all' : 'current')}
          >
            {group.name}
          </button>
          <p className="merchant-review__meta">
            {group.accountName} ·{' '}
            {group.kept
              ? `${group.transactionCount} reviewed transactions`
              : `${group.reviewCount} ${group.uncategorizedCount ? 'uncategorized' : 'to review'}`}
            {group.currentCount > 0 &&
              ` · ${formatCurrency(group.currentAmountCents / 100)} in activity`}
          </p>
          {group.categories.length > 0 && (
            <p className="merchant-review__meta">Current: {group.categories.join(' · ')}</p>
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
                setPanel(null);
              }}
            />
            {group.suggestion && categoryId === String(group.suggestion.categoryId) && (
              <small title={group.suggestion.reason}>Suggested from source / saved history</small>
            )}
          </div>
        )}
        {!group.kept && group.currentCount > 0 && (
          <button
            className="btn btn--primary btn--sm"
            disabled={blocked || !categoryId}
            onClick={() => void save('current')}
          >
            {busy ? 'Saving…' : `Save ${group.currentCount}`}
          </button>
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
      {!group.kept && group.uncategorizedCount === 0 && (
        <div className="merchant-review__secondary">
          <button
            className="btn btn--ghost btn--sm"
            disabled={blocked}
            onClick={() => open('current')}
          >
            Review {group.reviewCount}
          </button>
          <button
            className="btn btn--ghost btn--sm"
            disabled={blocked}
            onClick={() => void keep('current')}
          >
            These differences are intentional
          </button>
        </div>
      )}
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
            <button className="btn btn--ghost btn--sm" onClick={() => setPanel(null)}>
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
                      <button
                        className="merchant-review__description"
                        onClick={() => onInspect(row.ledgerTransactionId!)}
                      >
                        {row.merchant || row.description}
                      </button>
                      <IndividualCategory
                        key={`${row.ledgerTransactionId}:${row.category?.id}`}
                        row={row}
                        categories={categories}
                        changes={changes}
                      />
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() =>
                          setContextId(
                            contextId === row.ledgerTransactionId ? null : row.ledgerTransactionId,
                          )
                        }
                        aria-expanded={contextId === row.ledgerTransactionId}
                      >
                        Nearby activity
                      </button>
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
                      className="btn btn--primary btn--sm"
                      disabled={blocked || detail.isFetching}
                      onClick={() => void save('history')}
                    >
                      Move {detail.data.count} to{' '}
                      {categories.find((category) => category.id === Number(categoryId))?.name}
                    </button>
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
          {contextId && (
            <TransactionContext
              key={contextId}
              ledgerTransactionId={contextId}
              reviewIds={detail.data?.transactions.map((row) => row.ledgerTransactionId!) ?? []}
              panelId={contextPanelId}
            />
          )}
        </section>
      )}
    </article>
  );
}
