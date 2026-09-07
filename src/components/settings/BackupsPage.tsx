import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trpc, trpcClient } from '../../api/trpc';
import Modal from '../shared/Modal';

export default function BackupsPage() {
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
  return <div className="page">
    <div className="page__header"><h1>Backup and restore</h1></div>
    <p>Backups include imported files stored in the database, source facts, categories, notes, and budget plans. Browser sign-ins and API keys are separate.</p>
    <p>Copy backup files to another drive for protection if this computer fails.</p>
    {query.data && <p>Backup folder: <code style={{ overflowWrap: 'anywhere' }}>{query.data.backupDirectory}</code></p>}
    {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}
    {query.data?.restorePending ? <p role="status">Restore scheduled. Quit and reopen EasyMoney to use the restored database. Changes are paused until restart. A backup of the previous database was saved.</p>
      : <button className="btn btn-primary" disabled={busy || !query.data} onClick={() => void run(() => trpcClient.backups.create.mutate())}>Create backup</button>}
    {query.isPending && <p role="status">Loading backups…</p>}
    {query.data?.backups.length === 0 && <p>No backups yet.</p>}
    <ul>{query.data?.backups.map(backup => <li key={backup.id} style={{ marginBlock: 16, overflowWrap: 'anywhere' }}>
      <strong>{new Date(backup.createdAt).toLocaleString()}</strong> · {(backup.size / 1024 / 1024).toFixed(1)} MB
      <div>{backup.id}</div>
      <button disabled={busy || query.data?.restorePending} onClick={() => setSelected(backup.id)}>Review restore</button>
    </li>)}</ul>
    <Modal isOpen={Boolean(selected)} onClose={() => { if (!busy) setSelected(''); }} title="Review backup restore">
      {preview.isPending && <p>Validating backup…</p>}
      {preview.error && <p role="alert">{preview.error.message}</p>}
      {preview.data && <>
        <p>This backup contains {preview.data.accounts} accounts, {preview.data.files} source files, {preview.data.transactions} transactions, and {preview.data.annotations} transaction annotations.</p>
        <p>After restart, EasyMoney will use this backup. A snapshot of your current database will be saved first. The current database will also remain on disk.</p>
        <button disabled={busy} onClick={() => void run(() => trpcClient.backups.restore.mutate({ id: selected }))}>Restore after restart</button>
      </>}
    </Modal>
  </div>;
}
