import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { categoryReviewDetail } from '../../../server/app/categoryWorkspace';
import { trpc } from '../../api/trpc';
import { formatCurrency, formatDate } from '../../utils/formatters';
import GroupedCategorySelect from '../shared/GroupedCategorySelect';
import ReviewedTransactions, { useReviewedCategories } from '../transactions/ReviewedTransactions';
import TransactionContext from '../transactions/TransactionContext';

type Review = NonNullable<ReturnType<typeof categoryReviewDetail>>;

/** One decision first; selection tools and account context are deliberately opt-in. */
export default function CategoryReviewCard({
  group,
  changes,
  deciding,
  onDecide,
  onLater,
  onInspect,
  pagination,
}: {
  group: Review;
  changes: ReturnType<typeof useReviewedCategories>;
  deciding: boolean;
  onDecide: () => void;
  onLater: () => void;
  onInspect: (id: string) => void;
  pagination?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [individual, setIndividual] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [contextId, setContextId] = useState<string | null>(null);
  const panelId = useId();
  const categories = useQuery(trpc.categories.list.queryOptions(undefined, { enabled: editing }));
  const busy = deciding || changes.pending;
  const rows = expanded ? group.transactions : group.transactions.slice(0, 3);
  const partial = group.transactions.length !== group.transactionCount;
  const current = [...group.categories, ...(group.uncategorizedCount ? ['Uncategorized'] : [])];
  return (
    <article className="category-focus" aria-label="Current category check">
      <header className="category-focus__header">
        <span className="category-focus__eyebrow">
          {group.kept
            ? 'Previously kept'
            : group.conflict
              ? 'Categories differ'
              : group.movement
                ? 'Check money movement'
                : 'Missing a category'}
        </span>
        <h2>{group.name}</h2>
        <p>
          {group.accountName} · {group.transactionCount.toLocaleString()}{' '}
          {group.transactionCount === 1 ? 'transaction' : 'transactions'} ·{' '}
          {formatCurrency(group.amountCents / 100)} in activity
        </p>
        <p className="category-focus__dates">
          {formatDate(group.firstDate, 'medium')}
          {group.firstDate !== group.lastDate && ` – ${formatDate(group.lastDate, 'medium')}`}
        </p>
      </header>
      <div className="category-focus__assessment">
        <div className="category-focus__current">
          <span>Currently categorized as</span>
          <strong>{current.join(' · ')}</strong>
        </div>
        {group.conflict && <p>These may not all belong in the same category.</p>}
        {group.movement && (
          <p>This may be money movement rather than spending. Check before changing it.</p>
        )}
      </div>
      {!individual && (
        <>
          <ul className="category-focus__transactions" aria-label="Transactions in this check">
            {rows.map((row) => (
              <li key={row.ledgerTransactionId}>
                <button
                  className="category-focus__transaction"
                  onClick={() => onInspect(row.ledgerTransactionId!)}
                  disabled={busy}
                  title="Open transaction details"
                >
                  <span>{formatDate(row.date, 'medium')}</span>
                  <strong>{row.category?.name || 'Uncategorized'}</strong>
                  <span>{formatCurrency(row.amount, true)}</span>
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  aria-label={`Surrounding activity for ${row.merchant || row.description} on ${row.date.slice(0, 10)}`}
                  aria-expanded={contextId === row.ledgerTransactionId}
                  aria-controls={panelId}
                  onClick={() =>
                    setContextId(
                      contextId === row.ledgerTransactionId ? null : row.ledgerTransactionId!,
                    )
                  }
                >
                  Nearby
                </button>
              </li>
            ))}
          </ul>
          {group.transactions.length > 3 && (
            <button className="btn btn--ghost btn--sm" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show fewer' : `Show all ${group.transactions.length} on this page`}
            </button>
          )}
        </>
      )}
      {contextId && !individual && (
        <TransactionContext
          key={contextId}
          panelId={panelId}
          ledgerTransactionId={contextId}
          reviewIds={group.transactions.map((row) => row.ledgerTransactionId!)}
        />
      )}
      {editing ? (
        <div className="category-focus__edit">
          <label htmlFor={`${panelId}-category`}>
            Change{' '}
            {partial
              ? `these ${group.transactions.length} on this page`
              : group.transactionCount === 1
                ? 'this transaction'
                : `all ${group.transactionCount} transactions`}{' '}
            to
          </label>
          <div className="category-focus__edit-controls">
            <GroupedCategorySelect
              id={`${panelId}-category`}
              value={categoryId}
              categories={(categories.data?.categories ?? []).filter(
                (category) => category.name.toLowerCase() !== 'uncategorized',
              )}
              leadingOptions={[
                { value: '', label: 'Choose category…' },
                { value: '__uncategorized', label: 'Uncategorized' },
              ]}
              onChange={setCategoryId}
              disabled={busy || categories.isPending}
            />
            <button
              className="btn btn--primary"
              disabled={busy || !categoryId || categories.isPending}
              onClick={async () => {
                if (
                  await changes.apply(
                    group.transactions,
                    categoryId === '__uncategorized' ? null : Number(categoryId),
                    'Guided category review',
                  )
                )
                  setEditing(false);
              }}
            >
              {changes.pending
                ? 'Saving…'
                : `Save ${group.transactions.length === 1 ? 'category' : `for ${group.transactions.length} transactions`}`}
            </button>
            <button className="btn btn--ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {categories.error && <p role="alert">{categories.error.message}</p>}
          <p>You can undo this change. Notes and source data stay intact.</p>
        </div>
      ) : (
        !individual && (
          <div className="category-focus__actions">
            <button className="btn btn--primary" disabled={busy} onClick={() => setEditing(true)}>
              Change category…
            </button>
            <button
              className="btn btn--secondary"
              disabled={busy}
              onClick={onDecide}
              title="Leave categories unchanged. New or changed transactions can bring this check back."
            >
              {deciding ? 'Saving…' : group.kept ? 'Reopen review' : 'Keep current categories'}
            </button>
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={onLater}
              title="Skip for now without marking it correct. This check stays open."
            >
              Later
            </button>
          </div>
        )
      )}
      <div className="category-focus__individual">
        <button
          className="btn btn--ghost btn--sm"
          disabled={busy}
          aria-expanded={individual}
          onClick={() => {
            setIndividual(!individual);
            setEditing(false);
          }}
        >
          {individual ? 'Back to group decision' : 'Change only some transactions…'}
        </button>
        {individual && (
          <ReviewedTransactions
            changes={changes}
            transactions={group.transactions}
            selectVisibleOnly
            showContext
            label="Individual category corrections"
            onInspect={onInspect}
          />
        )}
      </div>
      {pagination}
    </article>
  );
}
