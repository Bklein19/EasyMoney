import { useDeferredValue, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { trpc } from '../../api/trpc';
import { useCategories } from '../../hooks/useCategories';
import { formatCurrency } from '../../utils/formatters';
import GroupedCategorySelect, { isUncategorized } from '../shared/GroupedCategorySelect';
import type { useReviewedCategories } from '../transactions/ReviewedTransactions';
import type { AnalyticsReportInput } from '../../../server/app/analytics';
import type { TransactionListItem } from '../../../server/app/types';
import SpendingTransactionRows from './SpendingTransactionRows';

type Sort = 'date_desc' | 'date_asc' | 'absolute_desc' | 'absolute_asc';
type Changes = ReturnType<typeof useReviewedCategories>;

export default function SpendingTransactions({ scope, nodeId, changes, onInspect }: {
  scope: AnalyticsReportInput; nodeId: string; changes: Changes; onInspect: (id: string) => void;
}) {
  const { categories } = useCategories();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [sortBy, setSortBy] = useState<Sort>('date_desc');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Map<string, TransactionListItem>>(new Map());
  const [categoryId, setCategoryId] = useState('');
  const query = useQuery(trpc.analytics.spendingTransactions.queryOptions({ scope, nodeId, search: deferredSearch, sortBy, offset }));
  const rows = query.data?.transactions ?? [];
  const busy = changes.pending || query.isFetching || search !== deferredSearch;
  const toggle = (row: TransactionListItem) => setSelected(previous => {
    const next = new Map(previous);
    if (next.has(row.ledgerTransactionId!)) next.delete(row.ledgerTransactionId!);
    else next.set(row.ledgerTransactionId!, row);
    return next;
  });
  const apply = async (targets: TransactionListItem[], destination: number | null) => {
    if (await changes.apply(targets, destination, 'Explore spending categories')) setSelected(new Map());
  };
  return <section className="spending-transactions" aria-label="Categorize spending">
    <p className="spending-transactions__hint">Change a category directly, or select transactions to edit together.</p>
    <div className="spending-transactions__filters">
      <label className="spending-explorer__search"><Search size={15} aria-hidden="true" /><input aria-label="Search spending transactions"
        placeholder="Find description, amount, or category…" value={search} disabled={changes.pending}
        onChange={event => { setSearch(event.target.value); setOffset(0); setSelected(new Map()); }} /></label>
      <select className="input input--sm" aria-label="Sort spending transactions" value={sortBy} disabled={changes.pending}
        onChange={event => { setSortBy(event.target.value as Sort); setOffset(0); }}>
        <option value="date_desc">Newest first</option><option value="date_asc">Oldest first</option>
        <option value="absolute_desc">Largest first</option><option value="absolute_asc">Smallest first</option>
      </select>
    </div>
    {query.error && <p role="alert">{query.error.message} <button type="button" className="btn btn--ghost btn--sm" onClick={() => void query.refetch()}>Retry</button></p>}
    <div className="spending-transactions__selection">
      <button type="button" className="btn btn--ghost btn--sm" disabled={busy || !rows.length}
        onClick={() => setSelected(previous => new Map([...previous, ...rows.filter(row => row.ledgerTransactionId && row.account).map(row => [row.ledgerTransactionId!, row] as const)]))}>Select shown ({rows.length})</button>
      {selected.size > 0 && <>
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setSelected(new Map())}>Clear</button>
        <GroupedCategorySelect categories={categories.filter(category => !isUncategorized(category))} value={categoryId}
          className="input input--sm" aria-label="Category for selected spending transactions" disabled={busy}
          leadingOptions={[{ value: '', label: 'Categorize selected…' }, { value: '__uncategorized', label: 'Uncategorized' }]} onChange={setCategoryId} />
        <button type="button" className="btn btn--primary btn--sm" disabled={busy || !categoryId}
          onClick={() => void apply([...selected.values()], categoryId === '__uncategorized' ? null : Number(categoryId))}>Apply to {selected.size} selected</button>
      </>}
    </div>
    {selected.size > 0 && <p className="spending-transactions__hint">Only the {selected.size} selected transactions will change, including selections on other pages. Changing search clears the selection.</p>}
    {query.isPending ? <p role="status">Loading transactions…</p> : <>
      <SpendingTransactionRows rows={rows} categories={categories} selected={selected} pending={busy} onToggle={toggle}
        onCategorize={(row, destination) => void apply([row], destination)} onInspect={onInspect} />
      {!rows.length && !query.error && <p className="spending-transactions__hint">No matching transactions remain in this group.</p>}
      <div className="spending-transactions__pagination">
        <span>{query.data?.totalCount ? `${offset + 1}–${offset + rows.length} of ${query.data.totalCount}` : '0 transactions'} · {formatCurrency(query.data?.totals.expenses ?? 0)} matching spending</span>
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy || offset === 0} onClick={() => setOffset(previous => Math.max(0, previous - 50))}>Previous</button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy || !query.data?.hasMore} onClick={() => setOffset(query.data!.nextOffset!)}>Next</button>
      </div>
    </>}
  </section>;
}
