import { formatCurrency, formatDate } from '../../utils/formatters';
import GroupedCategorySelect, { isUncategorized } from '../shared/GroupedCategorySelect';
import type { CategorySummary, TransactionListItem } from '../../../server/app/types';

export default function SpendingTransactionRows({ rows, categories, selected, pending, onToggle, onCategorize, onInspect }: {
  rows: TransactionListItem[];
  categories: CategorySummary[];
  selected: ReadonlyMap<string, TransactionListItem>;
  pending: boolean;
  onToggle: (row: TransactionListItem) => void;
  onCategorize: (row: TransactionListItem, categoryId: number | null) => void;
  onInspect: (id: string) => void;
}) {
  return <ul className="spending-transactions__rows" aria-label="Spending transactions">
    {rows.map(row => <li key={row.ledgerTransactionId}>
      <input type="checkbox" checked={selected.has(row.ledgerTransactionId!)} disabled={pending || !row.ledgerTransactionId || !row.account}
        aria-label={`Select ${row.merchant || row.description} on ${row.date.slice(0, 10)}`} onChange={() => onToggle(row)} />
      <div className="spending-transactions__identity">
        <button type="button" className="transaction-source-button" title={row.description ?? undefined}
          disabled={pending || !row.ledgerTransactionId} onClick={() => onInspect(row.ledgerTransactionId!)}>{row.merchant || row.description || 'Transaction'}</button>
        <span>{formatDate(row.date, 'medium')} · {[row.account?.institution, row.account?.name].filter(Boolean).join(' · ')}</span>
      </div>
      <strong>{formatCurrency(row.amount, true)}</strong>
      <GroupedCategorySelect categories={categories.filter(category => !isUncategorized(category))}
        value={!row.category || isUncategorized(row.category) ? '' : String(row.category.id)}
        leadingOptions={[{ value: '', label: 'Uncategorized' }]} className="input input--sm"
        aria-label={`Category for ${row.merchant || row.description} on ${row.date.slice(0, 10)}`}
        disabled={pending || !row.ledgerTransactionId || !row.account}
        onChange={value => onCategorize(row, value ? Number(value) : null)} />
    </li>)}
  </ul>;
}
