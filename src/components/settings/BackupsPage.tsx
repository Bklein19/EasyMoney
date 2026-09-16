import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trpc, trpcClient } from '../../api/trpc';
import Modal from '../shared/Modal';
import { useSearchParams } from 'react-router';
import ParserRefreshStatus from '../import/ParserRefreshStatus';
import SavedChoices from './SavedChoices';
import { backupReason, backupSection } from './backupPresentation';
import './BackupsPage.css';

export default function BackupsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const section = backupSection(searchParams.get('section'), searchParams.get('history'));
  const [limit, setLimit] = useState(10);
  const query = useQuery(trpc.backups.list.queryOptions());
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const preview = useQuery(trpc.backups.inspect.queryOptions({ id: selected }, { enabled: Boolean(selected) }));
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); setSelected(''); await query.refetch(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Backup operation failed.'); }
    finally { setBusy(false); }
  };
  return <div className="page recovery-page">
    <div className="page__header"><h1 className="page__title">Backups & history</h1><p className="page__subtitle">Recover your data or look up previous transaction categories and notes.</p></div>
    <nav className="recovery-tabs" aria-label="Backups and history sections">
      {([['backups', 'Database backups'], ['choices', 'Category history'], ['updates', 'Technical details']] as const).map(([key, label]) =>
        <button key={key} aria-current={section === key ? 'page' : undefined} onClick={() => setSearchParams({ section: key })}>{label}</button>)}
    </nav>
    {section === 'choices' && <SavedChoices />}
    {section === 'updates' && <section><h2>Import update details</h2><p className="recovery-muted">Diagnostic history for troubleshooting. You don’t need to manage this during normal use.</p><ParserRefreshStatus advanced /></section>}
    {section === 'backups' && <section>
    <div className="recovery-heading"><div><h2>Database backups</h2><p>Snapshots of your EasyMoney data, newest first.</p></div>
      <button className="btn btn--primary" disabled={busy || !query.data || query.data.restorePending} onClick={() => void run(() => trpcClient.backups.create.mutate())}>{busy ? 'Working…' : 'Create backup'}</button></div>
    <div className="recovery-note">Backups include retained original files, import history, categories, notes, and budget plans. Browser sign-ins and API keys aren’t included. Older backups contain only the originals retained at that time.</div>
    <details className="recovery-storage"><summary>Storage & off-device protection</summary><p>These backups are on this Mac. Copy them to another drive to protect against computer failure.</p>{query.data && <code>{query.data.backupDirectory}</code>}</details>
    {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}
    {query.data?.restorePending && <p role="status">Restore scheduled. Quit and reopen EasyMoney to use the restored database. Changes are paused until restart. A backup of the previous database was saved.</p>}
    {query.isPending && <p role="status">Loading backups…</p>}
    {query.data?.backups.length === 0 && <p>No backups yet.</p>}
    <div className="recovery-list">{query.data?.backups.slice(0, limit).map((backup, index) => <article className="backup-entry" key={backup.id}>
      <div><h3>{new Date(backup.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}{index === 0 && <span className="backup-latest">Latest</span>}</h3>
        <p className="recovery-muted">{backupReason(backup.id)} · {(backup.size / 1024 / 1024).toFixed(1)} MB</p>
        <details><summary>File details</summary><code>{backup.id}</code></details></div>
      <button className="btn btn--secondary btn--sm" disabled={busy || query.data?.restorePending} onClick={() => setSelected(backup.id)}>Review restore…</button>
    </article>)}</div>
    {(query.data?.backups.length ?? 0) > limit && <button className="btn btn--secondary recovery-more" onClick={() => setLimit(limit + 10)}>Show older backups</button>}
    </section>}
    <Modal isOpen={Boolean(selected)} onClose={() => { if (!busy) setSelected(''); }} title="Review backup restore">
      {preview.isPending && <p>Validating backup…</p>}
      {preview.error && <p role="alert">{preview.error.message}</p>}
      {preview.data && <>
        <p>This backup contains {preview.data.accounts} accounts, {preview.data.files} source files, {preview.data.transactions} transactions, and {preview.data.annotations} transaction annotations.</p>
        <p>After restart, EasyMoney will use this backup. A snapshot of your current database will be saved first. The current database will also remain on disk.</p>
        <button className="btn btn--primary" disabled={busy} onClick={() => void run(() => trpcClient.backups.restore.mutate({ id: selected }))}>Restore after restart</button>
      </>}
    </Modal>
  </div>;
}
