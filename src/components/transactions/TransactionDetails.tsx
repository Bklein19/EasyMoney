import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { trpc } from '../../api/trpc';
import { formatCurrency } from '../../utils/formatters';
import Modal from '../shared/Modal';

export default function TransactionDetails({ ledgerTransactionId, onClose }: { ledgerTransactionId: string; onClose: () => void }) {
  const query = useQuery(trpc.transactions.details.queryOptions({ ledgerTransactionId }));
  const detail = query.data;
  return <Modal isOpen onClose={onClose} title="Transaction source details" maxWidth="760px">
    {query.isPending && <p role="status">Loading source details…</p>}
    {query.error && <p role="alert">{query.error.message}</p>}
    {detail && <>
      <p><strong>{detail.transaction.description}</strong> · {formatCurrency(detail.transaction.amountCents / 100)} · {detail.transaction.date.slice(0, 10)}</p>
      <p>Account: {detail.transaction.accountName}. Category: {detail.transaction.categoryName || 'Uncategorized'}.</p>
      <p>Original description: {detail.transaction.originalDescription || detail.transaction.description}</p>
      {detail.transaction.notes && <p>Notes: {detail.transaction.notes}</p>}
      {!detail.sources.length && <p>No active source explanation is available for this transaction.</p>}
      {detail.sources.map(source => <section key={source.id} style={{ borderTop: '1px solid var(--border-color, #64748b)', paddingBlock: 12 }}>
        <strong>{source.selected ? 'Retained source' : 'Related source excluded during rebuild'}</strong>
        <p>{source.fileName} · {source.parserName || 'Unknown parser'} · {source.status}</p>
        <p>{source.sourceAccountName || 'Unnamed source account'} → {source.mappedAccountName || 'Unmapped account'}</p>
        <p>{source.date.slice(0, 10)} · {formatCurrency(source.amountCents / 100)} · {source.description}</p>
        <p>{source.reason}</p>
      </section>)}
      <Link to="/import">Open import history</Link>
    </>}
  </Modal>;
}
