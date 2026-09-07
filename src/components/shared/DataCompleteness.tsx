import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { trpc } from '../../api/trpc';

function calendarDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  if (value.length === 10) return value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function DataCompleteness({ accountIds, startDate, endDate }: { accountIds?: number[]; startDate?: string | null; endDate?: string | null }) {
  const query = useQuery(trpc.dataFreshness.completeness.queryOptions({ accountIds, startDate: calendarDate(startDate), endDate: calendarDate(endDate) }));
  if (query.error) return <p role="alert">Unable to check data completeness. <button onClick={() => void query.refetch()}>Retry</button></p>;
  if (!query.data) return <p role="status">Checking report coverage…</p>;
  const affected = query.data.accounts.filter(account => account.transactionCoverage !== 'declared' || account.balanceStatus !== 'current');
  if (!query.data.accounts.length) return null;
  return <details className="data-completeness" style={{ marginBlock: 16, padding: 12, border: '1px solid var(--border-color, #64748b)', borderRadius: 8 }}>
    <summary>{affected.length ? `${affected.length} account${affected.length === 1 ? '' : 's'} with unverified coverage or missing or older balances` : 'Imported date ranges cover this report; balances are recent'} · as of {query.data.asOf}</summary>
    <p>Declared coverage comes from file date ranges for a single account. Unverified dates may include quiet periods. Recent transactions do not refresh an older balance.</p>
    {query.data.accounts.map(account => <div key={account.accountId} style={{ marginBlock: 12 }}>
      <strong>{account.accountName}{account.closed ? ' · closed' : ''}</strong>
      <div>Latest transaction: {account.latestTransactionDate?.slice(0, 10) || 'none'} · Balance: {account.latestBalanceDate?.slice(0, 10) || 'none'} · {account.balanceStatus}</div>
      <div>{account.transactionCoverage === 'future' ? 'This period has not started.' : account.transactionCoverage === 'declared' ? 'Declared file ranges cover the selected period.' : `${account.gaps.length} date range${account.gaps.length === 1 ? '' : 's'} without declared coverage.`}</div>
      {account.gaps.length > 0 && <ul>{account.gaps.slice(0, 12).map(gap => <li key={gap.start}>{gap.start} through {gap.end}</li>)}</ul>}
      {account.gaps.length > 12 && <p>{account.gaps.length - 12} additional unverified ranges.</p>}
      <Link to={`/import?accountId=${account.accountId}`}>Import data for {account.accountName}</Link>
    </div>)}
  </details>;
}
