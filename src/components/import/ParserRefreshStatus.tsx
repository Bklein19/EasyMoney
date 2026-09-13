import { useQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';
import { trpc, queryClient } from '../../api/trpc';

export default function ParserRefreshStatus() {
  const status = useQuery({ ...trpc.imports.parserRefreshStatus.queryOptions(), refetchInterval: 3000 });
  const retry = useMutation(trpc.imports.refreshParsers.mutationOptions({
    onSuccess: () => { void queryClient.invalidateQueries(); },
  }));
  if (status.error) return <p role="alert">Unable to check parser refresh status.</p>;
  if (status.data?.running) return <p role="status">Refreshing changed parsers from retained originals. Your current ledger remains available.</p>;
  if (status.data?.error) return <p role="alert">{status.data.error} <button disabled={retry.isPending} onClick={() => retry.mutate()}>Retry</button></p>;
  if (!status.data?.issues.length) return null;
  return <details style={{ marginBlock: 16 }}>
    <summary>{status.data.issues.length} imports need review before their parser updates can be applied</summary>
    <p>The previous facts remain in use for these imports. Automatic updates preserve confirmed mappings and annotations. A pre-update snapshot is available in <Link to="/backups">Backups</Link>.</p>
    <button disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? 'Refreshing…' : 'Retry parser updates'}</button>
    {retry.error && <p role="alert">Refresh failed; previous data remains available.</p>}
    <ul>{status.data.issues.map(item => <li key={item.sourceFileId}>{item.fileName}: {item.reason}</li>)}</ul>
  </details>;
}
