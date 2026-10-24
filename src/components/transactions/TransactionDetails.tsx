import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { trpc } from '../../api/trpc';
import { useCategories } from '../../hooks/useCategories';
import { formatCurrency, formatDate } from '../../utils/formatters';
import Modal from '../shared/Modal';
import GroupedCategorySelect from '../shared/GroupedCategorySelect';
import ReviewedTransactions, {
  CategoryChangeFeedback,
  useReviewedCategories,
} from './ReviewedTransactions';
import './TransactionDetails.css';

export default function TransactionDetails({
  ledgerTransactionId,
  onClose,
}: {
  ledgerTransactionId: string;
  onClose: () => void;
}) {
  const [inspectedId, setInspectedId] = useState(ledgerTransactionId);
  const query = useQuery(
    trpc.transactions.details.queryOptions({ ledgerTransactionId: inspectedId }),
  );
  const detail = query.data;
  const { categories } = useCategories();
  const changes = useReviewedCategories();
  return (
    <Modal isOpen onClose={onClose} title="Transaction details" maxWidth="760px">
      {query.isPending && <p role="status">Loading transaction…</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      {detail && (
        <div className="transaction-detail">
          {inspectedId !== ledgerTransactionId && (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => setInspectedId(ledgerTransactionId)}
            >
              Back to original transaction
            </button>
          )}
          <div className="transaction-detail__hero">
            <h3>{detail.selected.merchant || detail.transaction.description || 'Transaction'}</h3>
            <strong>{formatCurrency(detail.transaction.amountCents / 100, true)}</strong>
          </div>
          <p>
            {formatDate(detail.transaction.date, 'medium')} ·{' '}
            {[detail.selected.account?.institution, detail.transaction.accountName]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <label className="transaction-detail__category">
            Category
            <GroupedCategorySelect
              categories={categories.filter(
                (category) => category.name.toLowerCase() !== 'uncategorized',
              )}
              value={
                detail.selected.category?.name.toLowerCase() === 'uncategorized'
                  ? ''
                  : String(detail.selected.category?.id ?? '')
              }
              aria-label="Transaction category"
              leadingOptions={[{ value: '', label: 'Uncategorized' }]}
              disabled={changes.pending}
              onChange={(value) =>
                void changes.apply(
                  [detail.selected],
                  value ? Number(value) : null,
                  'Transaction category',
                )
              }
            />
          </label>
          {detail.automaticCategory && (
            <p className="transaction-detail__hint">
              Automatically guessed · {detail.automaticCategory.reason} You can change this category
              above.
            </p>
          )}
          <CategoryChangeFeedback state={changes} />
          {detail.transaction.notes && <p>Notes: {detail.transaction.notes}</p>}
          <section>
            <h3>
              Related transactions{' '}
              <span className="transaction-detail__count">{detail.related.length}</span>
            </h3>
            <p className="transaction-detail__hint">
              Same merchant text, account and direction.{' '}
              {detail.categoryNames.length > 1
                ? `Categories differ: ${detail.categoryNames.join(', ')}. Check whether that’s intentional.`
                : `Categories agree: ${detail.categoryNames[0]}.`}
            </p>
            {detail.related.length > 0 ? (
              <ReviewedTransactions
                key={inspectedId}
                transactions={detail.related}
                label="Related transaction categories"
                onInspect={setInspectedId}
              />
            ) : (
              <p>
                No related transactions found. Checks and generic payment processors are kept
                separate.
              </p>
            )}
          </section>
          <details className="transaction-detail__evidence">
            <summary>Bank description & import evidence</summary>
            <p>{detail.transaction.originalDescription || detail.transaction.description}</p>
            {!detail.sources.length && (
              <p>No active source explanation is available for this transaction.</p>
            )}
            {detail.sources.map((source) => (
              <section
                key={source.id}
                style={{ borderTop: '1px solid var(--glass-border)', paddingBlock: 12 }}
              >
                <strong>
                  {source.selected ? 'Retained source' : 'Related source excluded during rebuild'}
                </strong>
                <p>
                  {source.fileName} · {source.parserName || 'Unknown parser'} · {source.status}
                </p>
                <p>
                  {source.sourceAccountName || 'Unnamed source account'} →{' '}
                  {source.mappedAccountName || 'Unmapped account'}
                </p>
                <p>
                  {source.date.slice(0, 10)} · {formatCurrency(source.amountCents / 100)} ·{' '}
                  {source.description}
                </p>
                <p>{source.reason}</p>
              </section>
            ))}
            <Link to="/import" onClick={onClose}>
              Open import history
            </Link>
          </details>
        </div>
      )}
    </Modal>
  );
}
