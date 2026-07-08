import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, Lock } from 'lucide-react';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import { formatDate } from '../../utils/formatters';

type FreshnessStatus = 'current' | 'due' | 'stale' | 'no-data' | 'closed';

interface FreshnessAccount {
  accountId: number;
  accountName: string;
  institution: string | null;
  accountType: string;
  latestTransactionDate: string | null;
  latestBalanceDate: string | null;
  latestFactDate: string | null;
  daysSinceLatestFact: number | null;
  status: FreshnessStatus;
  transactionCount: number;
  balanceCount: number;
  latestImportFileName: string | null;
  latestParserName: string | null;
  latestSourceType: string | null;
  latestImportedAt: string | null;
  suggestedDownloads: string[];
}

interface FreshnessReport {
  today: string;
  dueAfterDays: number;
  staleAfterDays: number;
  summary: {
    totalAccounts: number;
    currentAccounts: number;
    dueAccounts: number;
    staleAccounts: number;
    noDataAccounts: number;
    closedAccounts: number;
  };
  accounts: FreshnessAccount[];
}

const STATUS_LABELS: Record<FreshnessStatus, string> = {
  current: 'Current',
  due: 'Due',
  stale: 'Stale',
  'no-data': 'No data',
  closed: 'Closed',
};

const STATUS_ICONS = {
  current: CheckCircle2,
  due: Clock3,
  stale: AlertTriangle,
  'no-data': CircleDashed,
  closed: Lock,
};

function formatFreshnessDate(value: string | null) {
  if (!value) return '—';
  return formatDate(value, 'medium');
}

function formatAge(account: FreshnessAccount) {
  if (account.daysSinceLatestFact === null) return 'No imports';
  if (account.daysSinceLatestFact === 0) return 'Today';
  if (account.daysSinceLatestFact === 1) return '1 day';
  return `${account.daysSinceLatestFact} days`;
}

function accountSort(a: FreshnessAccount, b: FreshnessAccount) {
  const rank: Record<FreshnessStatus, number> = { stale: 0, 'no-data': 1, due: 2, current: 3, closed: 4 };
  return rank[a.status] - rank[b.status] ||
    (b.daysSinceLatestFact ?? Number.POSITIVE_INFINITY) - (a.daysSinceLatestFact ?? Number.POSITIVE_INFINITY) ||
    (a.institution || '').localeCompare(b.institution || '') ||
    a.accountName.localeCompare(b.accountName);
}

export default function DataFreshnessPanel() {
  const freshnessQuery = useQuery(trpc.dataFreshness.report.queryOptions());
  const report = freshnessQuery.data as FreshnessReport | undefined;
  const error = freshnessQuery.error ? freshnessQuery.error.message : '';

  const accounts = useMemo(
    () => [...(report?.accounts || [])].sort(accountSort),
    [report?.accounts]
  );
  const needsUpdate = (report?.summary.staleAccounts || 0) +
    (report?.summary.dueAccounts || 0) +
    (report?.summary.noDataAccounts || 0);

  const setAccountStatus = async (account: FreshnessAccount) => {
    if (account.status === 'closed') {
      await trpcClient.accounts.unarchive.mutate({ id: account.accountId });
    } else {
      await trpcClient.accounts.markClosed.mutate({ id: account.accountId });
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.dataFreshness.report.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.accounts.list.queryKey() }),
    ]);
  };

  return (
    <section className="data-freshness" aria-label="Data freshness">
      <div className="data-freshness__header">
        <div>
          <h2>Data Freshness</h2>
          <p>
            {report
              ? `${needsUpdate} account${needsUpdate === 1 ? '' : 's'} need attention. Stale after ${report.staleAfterDays} days.`
              : 'Checking latest imported activity and balances.'}
          </p>
        </div>
        {report && (
          <div className="data-freshness__summary" aria-label="Freshness summary">
            <span><strong>{report.summary.currentAccounts}</strong> current</span>
            <span><strong>{report.summary.dueAccounts}</strong> due</span>
            <span><strong>{report.summary.staleAccounts}</strong> stale</span>
            <span><strong>{report.summary.noDataAccounts}</strong> no data</span>
            <span><strong>{report.summary.closedAccounts}</strong> closed</span>
          </div>
        )}
      </div>

      {error && <div className="import-history__error">{error}</div>}
      {!report && !error && <div className="empty-state-simple">Loading freshness...</div>}

      {report && (
        <div className="data-freshness__table-wrap">
          <table className="data-freshness__table">
            <colgroup>
              <col className="data-freshness__col-account" />
              <col className="data-freshness__col-status" />
              <col className="data-freshness__col-latest" />
              <col className="data-freshness__col-import" />
              <col className="data-freshness__col-download" />
              <col className="data-freshness__col-action" />
            </colgroup>
            <thead>
              <tr>
                <th>Account</th>
                <th>Status</th>
                <th>Latest data</th>
                <th>Last import</th>
                <th>Download</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {accounts.map(account => {
                const StatusIcon = STATUS_ICONS[account.status];
                return (
                  <tr key={account.accountId}>
                    <td>
                      <strong>{account.accountName}</strong>
                      <small>{account.institution || 'Unknown institution'} · {account.accountType}</small>
                    </td>
                    <td>
                      <span className={`data-freshness__status ${account.status}`}>
                        <StatusIcon size={13} />
                        {STATUS_LABELS[account.status]}
                      </span>
                    </td>
                    <td>
                      <strong>{formatFreshnessDate(account.latestFactDate)}</strong>
                      <small>{formatAge(account)} old</small>
                    </td>
                    <td>
                      <strong>{account.latestParserName || '—'}</strong>
                      <small>{account.latestImportFileName || 'No committed import'}</small>
                    </td>
                    <td>
                      <span className="data-freshness__download-text">
                        {account.status === 'closed'
                          ? 'No catch-up needed'
                          : account.suggestedDownloads.length > 0
                          ? account.suggestedDownloads.join(', ')
                          : 'Custom CSV'}
                      </span>
                    </td>
                    <td className="data-freshness__actions">
                      <button
                        className="btn btn--secondary btn--sm"
                        type="button"
                        onClick={() => void setAccountStatus(account)}
                      >
                        {account.status === 'closed' ? 'Reopen' : 'Mark closed'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
