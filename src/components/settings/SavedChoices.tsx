import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { trpc } from '../../api/trpc';

export default function SavedChoices() {
  const query = useQuery(trpc.imports.parserRefreshStatus.queryOptions());
  const [search, setSearch] = useState('');
  const [all, setAll] = useState(false);
  const [limit, setLimit] = useState(20);
  const history = query.data?.annotationHistory ?? [];
  const rows = history.filter(row => (all || row.disposition === 'recategorization-needed') &&
    `${row.evidence.transaction.date} ${row.evidence.transaction.description} ${row.evidence.categoryName ?? ''} ${row.evidence.annotation.notes ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  return <section aria-labelledby="saved-choices-title">
    <div className="recovery-heading"><div><h2 id="saved-choices-title">Category history</h2>
      <p>Previous categories and notes, kept when imported transactions were updated.</p></div>
      <Link className="btn btn--secondary" to="/transactions">Go to transactions</Link></div>
    <div className="recovery-note">You don’t need to restore a backup. These are previous transaction categories and notes for reference, not a list of unfinished tasks. When a category couldn’t be matched safely, it wasn’t copied to the corrected transactions.</div>
    <div className="recovery-filters">
      <input aria-label="Search category history" placeholder="Search description, date, or category…" value={search} onChange={event => { setSearch(event.target.value); setLimit(20); }} />
      <label><input type="checkbox" checked={all} onChange={event => { setAll(event.target.checked); setLimit(20); }} /> Include other update history</label>
    </div>
    {query.isPending && <p role="status">Loading category history…</p>}
    {query.error && <p role="alert">Couldn’t load category history. <button onClick={() => void query.refetch()}>Try again</button></p>}
    {!query.isPending && !query.error && <>
      <p className="recovery-muted">{rows.length} historical {rows.length === 1 ? 'entry' : 'entries'}</p>
      {!rows.length && <div className="recovery-note">No category history matches this view.</div>}
      <div className="recovery-list">{rows.slice(0, limit).map(row => <article className="saved-choice" key={row.id}>
        <div><time>{String(row.evidence.transaction.date)}</time><h3>{String(row.evidence.transaction.description)}</h3>
          <p className="recovery-muted">{row.disposition === 'recategorization-needed' ? 'Category not carried over' : row.disposition === 'transferred' ? 'Category or note carried over safely' : 'Kept for reference'}</p></div>
        <div><span className="recovery-label">Previous category</span><strong>{row.evidence.categoryName ?? 'Uncategorized'}</strong>
          {row.evidence.annotation.notes && <p>Note: {row.evidence.annotation.notes}</p>}</div>
        <details><summary>Update details</summary><p>{row.reason}</p><p>Saved {new Date(row.createdAt).toLocaleString()}. The description above is from the previous version and may contain parsing errors.</p></details>
      </article>)}</div>
      {rows.length > limit && <button className="btn btn--secondary recovery-more" onClick={() => setLimit(limit + 20)}>Show 20 more</button>}
    </>}
  </section>;
}
