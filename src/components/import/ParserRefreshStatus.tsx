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
  const issues = status.data.issues;
  const direct = issues.filter(item => item.status === 'review-required');
  const involved = issues.filter(item => item.status === 'conflict-involved');
  const held = issues.filter(item => item.status === 'held');
  const diagnostics = status.data.diagnostics;
  return <details style={{ marginBlock: 16 }}>
    <summary>Parser updates paused: {direct.length} file issues, {involved.length} conflict-involved files, {held.length} otherwise-valid files held</summary>
    <p>The previous facts remain in use for these imports. Automatic updates preserve confirmed mappings and annotations. A pre-update snapshot is available in <Link to="/backups">Backups</Link>.</p>
    <button disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? 'Refreshing…' : 'Retry parser updates'}</button>
    {retry.error && <p role="alert">Refresh failed; previous data remains available.</p>}
    {diagnostics && <section>
      <h3>Candidate-ledger conflicts</h3>
      <p>{diagnostics.conflicts.filter(c => c.kind === 'transaction').length} transaction ambiguity groups; {diagnostics.conflicts.filter(c => c.kind === 'balance').length} balance disagreements.</p>
      <p>{diagnostics.conflicts.filter(c => c.origin === 'existing').length} unchanged from the pre-refresh source facts; {diagnostics.conflicts.filter(c => c.origin === 'new').length} new or changed groups; {diagnostics.resolved.length} prior groups no longer present. This compares source-fact rebuilds, not a claim that the saved ledger already contained duplicates.</p>
      <p>Evidence captured {new Date(diagnostics.generatedAt).toLocaleString()}. Files in a conflict are not necessarily parsed incorrectly. Unrelated files remain held because updates apply as one atomic batch.</p>
      {diagnostics.conflicts.map(conflict => <details key={conflict.key}>
        <summary>{conflict.kind === 'balance' ? 'Balance disagreement' : 'Possible transaction overlap'} · {conflict.origin === 'existing' ? 'Pre-existing' : 'New or changed'} · {conflict.members[0]?.accountName} · {conflict.members[0]?.date}</summary>
        <ul>{conflict.members.map((member, index) => <li key={index}>{member.fileName} · {member.date} · {(member.amountCents / 100).toFixed(2)} · {member.description}</li>)}</ul>
      </details>)}
    </section>}
    {!!direct.length && <details><summary>{direct.length} file-specific parsing or mapping issues</summary>
      <ul>{direct.map(item => <li key={item.sourceFileId}>{item.fileName}: {item.reason}</li>)}</ul>
    </details>}
    {!!held.length && <details><summary>{held.length} successfully parsed files held, not individually flagged</summary>
      <p>{held[0]?.reason}</p>
      <ul>{held.map(item => <li key={item.sourceFileId}>{item.fileName}</li>)}</ul>
    </details>}
  </details>;
}
