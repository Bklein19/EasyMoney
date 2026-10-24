import { useState } from 'react';
import { Link } from 'react-router';
import type { ReviewGroup } from '../../../server/app/transactionReview';
import { formatCurrency } from '../../utils/formatters';
import Modal from '../shared/Modal';
import ReviewedTransactions from '../transactions/ReviewedTransactions';
import TransactionDetails from '../transactions/TransactionDetails';
import './WorthReviewing.css';

export default function WorthReviewing({
  report,
}: {
  report: { groups: ReviewGroup[]; totalGroups: number };
}) {
  const [selected, setSelected] = useState<ReviewGroup | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const selectedRows = report.groups.find((group) => group.id === selected?.id)?.transactions ?? [];
  return (
    <section className="worth-reviewing" aria-label="Worth reviewing">
      <div className="worth-reviewing__heading">
        <div>
          <h3>Worth reviewing</h3>
          <p>A few high-impact checks in this date and account selection. Flags aren’t verdicts.</p>
        </div>
        <Link to="/transactions/review">AI category review</Link>
      </div>
      {!report.groups.length && <p>No category checks found in this selection.</p>}
      <ul className="worth-reviewing__groups">
        {report.groups.map((group) => (
          <li key={group.id}>
            <button type="button" onClick={() => setSelected(group)}>
              <span>
                <strong>{group.name}</strong>
                <small>
                  {group.accountName} · {group.transactions.length.toLocaleString()} transaction
                  {group.transactions.length === 1 ? '' : 's'}
                </small>
                <span className="worth-reviewing__reason">{group.reasons.join(' · ')}</span>
              </span>
              <span className="worth-reviewing__amount">
                {formatCurrency(group.amountCents / 100)}
                <small>in activity · Review →</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {report.totalGroups > report.groups.length && (
        <p className="worth-reviewing__more">
          Showing {report.groups.length} of {report.totalGroups.toLocaleString()} groups,
          prioritized by flags and activity amount.
        </p>
      )}
      <Modal
        isOpen={Boolean(selected) && !inspectedId}
        onClose={() => setSelected(null)}
        title="Review categories"
        maxWidth="800px"
      >
        {selected && (
          <>
            <h3>{selected.name}</h3>
            <p>{selected.accountName}</p>
            {selected.reasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
            <p className="transaction-detail__hint">
              Choose only the transactions that belong together. Nothing is selected or changed
              automatically.
            </p>
            <ReviewedTransactions
              key={selected.id}
              transactions={selectedRows}
              label="Worth reviewing categories"
              onInspect={setInspectedId}
            />
          </>
        )}
      </Modal>
      {inspectedId && (
        <TransactionDetails
          key={inspectedId}
          ledgerTransactionId={inspectedId}
          onClose={() => setInspectedId(null)}
        />
      )}
    </section>
  );
}
