import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { queryClient, trpcClient } from '../../api/trpc';
import { useCategories } from '../../hooks/useCategories';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { reviewedTransaction } from '../../../server/app/transactionReview';
import type { TransactionListItem } from '../../../server/app/types';
import GroupedCategorySelect from '../shared/GroupedCategorySelect';
import './TransactionDetails.css';
import TransactionContext from './TransactionContext';

export function useReviewedCategories() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<{ id: number; count: number } | null>(null);
  const apply = async (rows: TransactionListItem[], categoryId: number | null, label: string) => {
    setPending(true);
    setError('');
    try {
      const result = await trpcClient.transactions.applyReviewedCategories.mutate({
        label,
        changes: rows.map((row) => ({ ...reviewedTransaction(row), categoryId })),
      });
      setUndo(result.undoOperation);
      await queryClient.invalidateQueries();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setPending(false);
    }
  };
  const restore = async () => {
    if (!undo) return;
    setPending(true);
    setError('');
    try {
      await trpcClient.transactions.restoreCategories.mutate({ undoOperationId: undo.id });
      setUndo(null);
      await queryClient.invalidateQueries();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return { pending, error, undo, apply, restore, remember: setUndo };
}

export function CategoryChangeFeedback({
  state,
}: {
  state: ReturnType<typeof useReviewedCategories>;
}) {
  return (
    <>
      {state.error && <p role="alert">{state.error}</p>}
      {state.undo && (
        <p className="category-review-feedback" role="status">
          Updated {state.undo.count} transaction{state.undo.count === 1 ? '' : 's'}. Backup saved.
          <button
            className="btn btn--ghost btn--sm"
            disabled={state.pending}
            onClick={() => void state.restore()}
          >
            Undo
          </button>
        </p>
      )}
    </>
  );
}

export default function ReviewedTransactions({
  transactions,
  onInspect,
  label,
  showContext = false,
  introduction,
  changes,
  selectVisibleOnly = false,
}: {
  transactions: TransactionListItem[];
  onInspect: (id: string) => void;
  label: string;
  showContext?: boolean;
  introduction?: ReactNode;
  changes?: ReturnType<typeof useReviewedCategories>;
  selectVisibleOnly?: boolean;
}) {
  const { categories } = useCategories();
  const localChanges = useReviewedCategories();
  const state = changes ?? localChanges;
  const [selected, setSelected] = useState<Map<string, TransactionListItem>>(new Map());
  const [categoryId, setCategoryId] = useState('');
  const [limit, setLimit] = useState(10);
  const [contextId, setContextId] = useState(transactions[0]?.ledgerTransactionId ?? null);
  const contextPanelId = useId();
  // Preserve what the user actually selected. A background refresh must not silently
  // replace the expected facts; the server rejects stale selections atomically.
  const rows = [...selected.values()];
  const visible = transactions.slice(0, limit);
  const toggle = (row: TransactionListItem) =>
    setSelected((previous) => {
      const next = new Map(previous);
      const id = row.ledgerTransactionId!;
      if (next.has(id)) next.delete(id);
      else next.set(id, row);
      return next;
    });
  return (
    <div className={showContext ? 'category-review-layout' : undefined}>
      <div className="category-review-list">
        {introduction && <div className="category-review-introduction">{introduction}</div>}
        <div className="category-review-controls">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={state.pending}
            onClick={() =>
              setSelected(
                new Map(
                  (selectVisibleOnly ? visible : transactions).map((row) => [
                    row.ledgerTransactionId!,
                    row,
                  ]),
                ),
              )
            }
          >
            {selectVisibleOnly
              ? `Select shown ${visible.length}`
              : `Select all ${transactions.length}`}
          </button>
          {selected.size > 0 && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={state.pending}
              onClick={() => setSelected(new Map())}
            >
              Clear selection
            </button>
          )}
          <GroupedCategorySelect
            value={categoryId}
            categories={categories.filter(
              (category) => category.name.toLowerCase() !== 'uncategorized',
            )}
            leadingOptions={[
              { value: '', label: 'Choose category…' },
              { value: '__uncategorized', label: 'Uncategorized' },
            ]}
            aria-label="Category for selected transactions"
            disabled={state.pending}
            onChange={setCategoryId}
          />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={state.pending || !rows.length || !categoryId}
            onClick={async () => {
              if (
                await state.apply(
                  rows,
                  categoryId === '__uncategorized' ? null : Number(categoryId),
                  label,
                )
              )
                setSelected(new Map());
            }}
          >
            {state.pending ? 'Saving…' : `Apply to ${rows.length} selected`}
          </button>
        </div>
        {rows.length > 0 && (
          <p className="category-review-impact">
            Only these {rows.length} selected transactions (
            {formatCurrency(rows.reduce((sum, row) => sum + Math.abs(row.amount), 0))} in activity)
            will change. Notes and source data stay intact.
          </p>
        )}
        {!changes && <CategoryChangeFeedback state={state} />}
        <ul className="related-transactions" aria-label="Transactions to review">
          {visible.map((row) => (
            <li key={row.ledgerTransactionId}>
              <input
                type="checkbox"
                aria-label={`Select ${row.merchant || row.description} on ${row.date.slice(0, 10)}`}
                disabled={state.pending}
                checked={selected.has(row.ledgerTransactionId!)}
                onChange={() => toggle(row)}
              />
              <button
                type="button"
                className="related-transactions__name"
                disabled={state.pending}
                onClick={() => onInspect(row.ledgerTransactionId!)}
              >
                <strong>{row.merchant || row.description || 'Transaction'}</strong>
                <span>
                  {formatDate(row.date, 'medium')} · {row.category?.name || 'Uncategorized'}
                </span>
              </button>
              <span>{formatCurrency(row.amount, true)}</span>
              {showContext && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm category-review-context-button"
                  aria-label={`View surrounding activity for ${row.merchant || row.description} on ${row.date.slice(0, 10)}`}
                  aria-controls={contextPanelId}
                  aria-pressed={contextId === row.ledgerTransactionId}
                  onClick={() => setContextId(row.ledgerTransactionId!)}
                >
                  Nearby activity
                </button>
              )}
            </li>
          ))}
        </ul>
        {limit < transactions.length && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setLimit((previous) => previous + 20)}
          >
            Show more ({transactions.length - limit} remaining)
          </button>
        )}
      </div>
      {showContext && contextId && (
        <TransactionContext
          key={contextId}
          ledgerTransactionId={contextId}
          reviewIds={transactions.flatMap((row) =>
            row.ledgerTransactionId ? [row.ledgerTransactionId] : [],
          )}
          panelId={contextPanelId}
        />
      )}
    </div>
  );
}
