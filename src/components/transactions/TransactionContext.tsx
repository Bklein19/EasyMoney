import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trpc } from '../../api/trpc';
import type { TransactionListItem } from '../../../server/app/types';
import { formatCurrency, formatDate } from '../../utils/formatters';
import './TransactionContext.css';

export function TransactionContextRows({
  transactions,
  anchorId,
  reviewIds,
  listRef,
}: {
  transactions: TransactionListItem[];
  anchorId: string;
  reviewIds: string[];
  listRef?: React.RefObject<HTMLOListElement | null>;
}) {
  return (
    <ol
      ref={listRef}
      className="transaction-context__rows"
      aria-label="Surrounding account transactions"
      tabIndex={0}
    >
      {transactions.map((row) => {
        const focused = row.ledgerTransactionId === anchorId;
        const underReview = reviewIds.includes(row.ledgerTransactionId!);
        return (
          <li
            key={row.ledgerTransactionId}
            className={focused ? 'transaction-context__row--focused' : undefined}
            aria-current={focused ? 'true' : undefined}
          >
            <div className="transaction-context__row-heading">
              <time dateTime={row.date.slice(0, 10)}>{formatDate(row.date, 'medium')}</time>
              {(focused || underReview) && (
                <span className="transaction-context__badge">
                  {focused ? 'Focused' : 'Under review'}
                </span>
              )}
              <strong className="transaction-context__amount">
                {formatCurrency(row.amount, true)}
              </strong>
            </div>
            <p>{row.merchant || row.description || row.originalDescription || 'Transaction'}</p>
            {row.description && row.merchant && row.description !== row.merchant && (
              <p className="transaction-context__description">{row.description}</p>
            )}
            <span className="transaction-context__category">
              {row.category?.name || 'Uncategorized'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default function TransactionContext({
  ledgerTransactionId,
  reviewIds,
  panelId,
}: {
  ledgerTransactionId: string;
  reviewIds: string[];
  panelId: string;
}) {
  const [beforeLimit, setBeforeLimit] = useState(4);
  const [afterLimit, setAfterLimit] = useState(4);
  const listRef = useRef<HTMLOListElement>(null);
  const scrollIntent = useRef<'anchor' | 'start' | 'end' | null>('anchor');
  const query = useQuery({
    ...trpc.transactions.context.queryOptions({ ledgerTransactionId, beforeLimit, afterLimit }),
    placeholderData: (previous) => previous,
  });
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!query.data || query.isPlaceholderData || !list || !scrollIntent.current) return;
    const focused = list.querySelector<HTMLElement>('[aria-current="true"]');
    if (scrollIntent.current === 'anchor' && focused) {
      list.scrollTop += focused.getBoundingClientRect().top - list.getBoundingClientRect().top;
    } else {
      list.scrollTop = scrollIntent.current === 'end' ? list.scrollHeight : 0;
    }
    scrollIntent.current = null;
  }, [query.data, query.isPlaceholderData]);
  return (
    <section
      id={panelId}
      className="transaction-context"
      aria-label="Surrounding activity"
      aria-busy={query.isFetching}
    >
      <header>
        <h4>Surrounding activity</h4>
        {query.data?.anchor.account && (
          <p>
            {[query.data.anchor.account.institution, query.data.anchor.account.name]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        <p>Same account, across all categories. Context only—not included in Apply.</p>
      </header>
      {query.isPending && <p role="status">Loading surrounding transactions…</p>}
      {query.error && (
        <p role="alert">
          {query.error.message}{' '}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        </p>
      )}
      {query.data && (
        <>
          {query.data.hasEarlier && beforeLimit < 50 && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={query.isFetching}
              onClick={() => {
                scrollIntent.current = 'start';
                setBeforeLimit((limit) => Math.min(50, limit + 10));
              }}
            >
              Show earlier activity
            </button>
          )}
          <TransactionContextRows
            transactions={query.data.transactions}
            anchorId={ledgerTransactionId}
            reviewIds={reviewIds}
            listRef={listRef}
          />
          {query.data.transactions.length === 1 && <p>No other transactions in this account.</p>}
          {query.data.hasLater && afterLimit < 50 && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={query.isFetching}
              onClick={() => {
                scrollIntent.current = 'end';
                setAfterLimit((limit) => Math.min(50, limit + 10));
              }}
            >
              Show later activity
            </button>
          )}
          {((query.data.hasEarlier && beforeLimit === 50) ||
            (query.data.hasLater && afterLimit === 50)) && (
            <p>Context is limited to the nearest 50 transactions in each direction.</p>
          )}
          <p className="transaction-context__note">
            Dates only; same-day rows aren’t ordered by time.
          </p>
        </>
      )}
    </section>
  );
}
