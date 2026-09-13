import { useQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';
import { trpc, queryClient } from '../../api/trpc';

export default function ParserRefreshStatus() {
  const status = useQuery({ ...trpc.imports.parserRefreshStatus.queryOptions(), refetchInterval: 3000 });
  const retry = useMutation(trpc.imports.previewParserRefresh.mutationOptions({
    onSuccess: () => { void queryClient.invalidateQueries(); },
  }));
  const apply = useMutation(trpc.imports.applyParserRefresh.mutationOptions({ onSuccess: () => { void queryClient.invalidateQueries(); } }));
  if (status.error) return <p role="alert">Unable to check parser refresh status.</p>;
  if (status.data?.running) return <p role="status">Refreshing changed parsers from retained originals. Your current ledger remains available.</p>;
  if (status.data?.error) return <p role="alert">{status.data.error} <button disabled={retry.isPending} onClick={() => retry.mutate()}>Retry</button></p>;
  const history = status.data?.annotationHistory ?? [];
  if (!status.data?.issues.length && !history.length) return null;
  const issues = status.data?.issues ?? [];
  const direct = issues.filter(item => item.status === 'review-required');
  const involved = issues.filter(item => item.status === 'conflict-involved');
  const held = issues.filter(item => item.status === 'held');
  const diagnostics = status.data?.diagnostics;
  const preview = diagnostics?.preview;
  return <details style={{ marginBlock: 16 }}>
    <summary>{issues.length ? `Parser updates paused: ${direct.length} file issues, ${involved.length} conflict-involved files, ${held.length} otherwise-valid files held` : `Parser refresh history · ${history.length} preserved annotation records`}</summary>
    <p>{issues.length ? 'The previous facts remain in use for these imports. ' : ''}Automatic updates preserve confirmed mappings and annotations. Pre-update snapshots are available in <Link to="/backups">Backups</Link>.</p>
    {!!issues.length && <button disabled={retry.isPending || apply.isPending} onClick={() => retry.mutate()}>{retry.isPending ? 'Previewing…' : 'Preview parser updates'}</button>}
    {preview && <section>
      <h3>Proposed ledger changes</h3>
      <p>{preview.candidateFiles} files · {preview.transactionCountBefore} → {preview.transactionCountAfter} transactions. {preview.added.length} new identities; {preview.removed.length} retired identities. Identity changes can represent corrected or deduplicated transactions, not new spending.</p>
      <p>Annotations: {preview.annotationCounts.unchanged} unchanged, {preview.annotationCounts.transferred} transferred with source evidence, {preview.annotationCounts['retained-history']} retained in history, {preview.annotationCounts['review-required']} need review.</p>
      <details><summary>Transaction changes</summary>
        {[['Retired',preview.removed],['Added',preview.added]].map(([label, rows])=><section key={String(label)}><h4>{String(label)}</h4>
          <ul>{(rows as typeof preview.added).map(row=><li key={row.ledgerTransactionId}>Account {row.accountId} · {row.date} · {row.amount.toFixed(2)} · {row.description}</li>)}</ul>
        </section>)}
      </details>
      <details><summary>Same-identity corrections ({preview.updated.length})</summary><ul>{preview.updated.map(row=><li key={row.ledgerTransactionId}>{row.before.date} · {row.before.description} → {row.after.date} · {row.after.description}</li>)}</ul></details>
      <details><summary>Balance changes ({preview.balanceChanges.length})</summary><ul>{preview.balanceChanges.map(row=><li key={`${row.accountId}:${row.month}`}>
        Account {row.accountId} · {row.month}: {row.beforeCents===null?'none':(row.beforeCents/100).toFixed(2)} ({row.beforeDate ?? 'no date'}) → {row.afterCents===null?'none':(row.afterCents/100).toFixed(2)} ({row.afterDate ?? 'no date'})
      </li>)}</ul></details>
      <details><summary>Account mapping evidence</summary><ul>{preview.mappings.map(row=><li key={`${row.sourceFileId}:${row.sourceAccountKey}`}>File {row.sourceFileId} · {row.sourceAccountKey} → Account {row.accountId} · {row.evidence}</li>)}</ul></details>
      {preview.annotations.map(row=><details key={row.ledgerTransactionId}><summary>{row.disposition} · {String(row.evidence.transaction.description)} · {String(row.evidence.transaction.date)}</summary>
        <p>{row.reason}</p><p>Category: {row.evidence.categoryName ?? row.evidence.annotation.categoryId ?? 'none'} · Notes: {row.evidence.annotation.notes || 'none'}</p>
      </details>)}
      <button disabled={apply.isPending || retry.isPending || preview.annotationCounts['review-required'] > 0 || diagnostics.conflicts.some(c=>c.kind==='balance'||c.origin==='new')}
        onClick={()=>apply.mutate({inputRevision:diagnostics.inputRevision})}>{apply.isPending?'Applying…':'Apply this validated preview'}</button>
      {apply.error && <p role="alert">{apply.error.message}</p>}
    </section>}
    {!!history.length && <details><summary>Preserved annotation history ({history.length})</summary>
      {history.map(row=><details key={row.id}><summary>{String(row.evidence.transaction.date)} · {String(row.evidence.transaction.description)} · {row.disposition}</summary>
        <p>{row.reason}</p><p>Category: {row.evidence.categoryName ?? row.evidence.annotation.categoryId ?? 'none'} · Notes: {row.evidence.annotation.notes || 'none'}</p>
        <p>Original ledger identity: {row.ledgerTransactionId}. Source files: {Array.from(new Set(row.evidence.sources.map(source=>source.sourceFileId))).join(', ')}.</p>
      </details>)}
    </details>}
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
