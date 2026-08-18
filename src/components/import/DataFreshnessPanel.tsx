import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, CircleDashed, Clock3, History, LoaderCircle, Lock, RefreshCw, X } from 'lucide-react';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import { formatDate } from '../../utils/formatters';

type FreshnessStatus = 'current' | 'due' | 'stale' | 'no-data' | 'closed';
type SyncInstitutionId = 'bank-of-america' | 'vanguard';

interface SyncInstitution {
  id: SyncInstitutionId;
  label: string;
  matches: (institution: string) => boolean;
}

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

const SYNC_INSTITUTIONS: SyncInstitution[] = [
  {
    id: 'bank-of-america',
    label: 'Bank of America',
    matches: institution => institution.includes('bank of america'),
  },
  {
    id: 'vanguard',
    label: 'Vanguard',
    matches: institution => institution.includes('vanguard'),
  },
];

interface SyncActionMenuProps {
  institutions: SyncInstitution[];
  kind: 'current' | 'backfill';
  onSelect: (institutionId: SyncInstitutionId, kind: 'current' | 'backfill') => void;
}

function SyncActionMenu({ institutions, kind, onSelect }: SyncActionMenuProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const isCurrent = kind === 'current';
  const Icon = isCurrent ? RefreshCw : History;
  const label = isCurrent ? 'Catch up' : 'Import history';

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!detailsRef.current?.contains(event.target as Node)) detailsRef.current?.removeAttribute('open');
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') detailsRef.current?.removeAttribute('open');
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  return (
    <details className={`data-freshness__sync-menu ${isCurrent ? 'is-primary' : ''}`} ref={detailsRef}>
      <summary>
        <Icon size={14} />
        {label}
        <ChevronDown className="data-freshness__sync-chevron" size={14} />
      </summary>
      <div className="data-freshness__sync-menu-panel" role="menu" aria-label={`${label} institution`}>
        {institutions.map(institution => (
          <button
            key={institution.id}
            type="button"
            role="menuitem"
            onClick={() => {
              detailsRef.current?.removeAttribute('open');
              onSelect(institution.id, kind);
            }}
          >
            {institution.label}
          </button>
        ))}
      </div>
    </details>
  );
}

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
  const [syncRunId, setSyncRunId] = useState(() => localStorage.getItem('easymoney-active-sync-run') || '');
  const freshnessQuery = useQuery(trpc.dataFreshness.report.queryOptions());
  const syncQuery = useQuery({
    ...trpc.dataSync.status.queryOptions({ runId: syncRunId || 'none' }),
    enabled: Boolean(syncRunId),
    refetchInterval: query => query.state.data?.status === 'running' ? 750 : false,
  });
  const report = freshnessQuery.data as FreshnessReport | undefined;
  const syncJob = syncQuery.data;
  const error = freshnessQuery.error ? freshnessQuery.error.message : '';

  const accounts = useMemo(
    () => [...(report?.accounts || [])].sort(accountSort),
    [report?.accounts]
  );
  const needsUpdate = (report?.summary.staleAccounts || 0) +
    (report?.summary.dueAccounts || 0) +
    (report?.summary.noDataAccounts || 0);
  const syncInstitutions = useMemo(() => SYNC_INSTITUTIONS.filter(institution =>
    accounts.some(account =>
      account.status !== 'closed' && institution.matches(account.institution?.toLowerCase() ?? '')
    )
  ), [accounts]);

  useEffect(() => {
    if (!syncJob || syncJob.status === 'running') return;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.dataFreshness.report.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.imports.history.queryKey() }),
    ]);
  }, [syncJob?.status]);

  const startInstitutionSync = async (
    institutionId: SyncInstitutionId,
    kind: 'current' | 'backfill',
  ) => {
    const goal = kind === 'current'
      ? { kind: 'current' as const, overlapDays: 7 }
      : { kind: 'backfill' as const };
    const job = await trpcClient.dataSync.start.mutate({ institutionId, goal });
    localStorage.setItem('easymoney-active-sync-run', job.runId);
    setSyncRunId(job.runId);
  };

  const cancelSync = async () => {
    if (!syncRunId) return;
    await trpcClient.dataSync.cancel.mutate({ runId: syncRunId });
    await syncQuery.refetch();
  };

  const dismissSync = () => {
    localStorage.removeItem('easymoney-active-sync-run');
    setSyncRunId('');
  };

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
        {report && <div className="data-freshness__header-actions">
          {syncInstitutions.length > 0 && syncJob?.status !== 'running' && (
            <div className="data-freshness__sync-actions">
              <SyncActionMenu
                institutions={syncInstitutions}
                kind="backfill"
                onSelect={(institutionId, kind) => void startInstitutionSync(institutionId, kind)}
              />
              <SyncActionMenu
                institutions={syncInstitutions}
                kind="current"
                onSelect={(institutionId, kind) => void startInstitutionSync(institutionId, kind)}
              />
            </div>
          )}
          <div className="data-freshness__summary" aria-label="Freshness summary">
            <span><strong>{report.summary.currentAccounts}</strong> current</span>
            <span><strong>{report.summary.dueAccounts}</strong> due</span>
            <span><strong>{report.summary.staleAccounts}</strong> stale</span>
            <span><strong>{report.summary.noDataAccounts}</strong> no data</span>
            <span><strong>{report.summary.closedAccounts}</strong> closed</span>
          </div>
        </div>}
      </div>

      {syncJob && (
        <div className={`data-freshness__sync-status is-${syncJob.status}`} role="status">
          {syncJob.status === 'running' && <LoaderCircle className="spin" size={15} />}
          <span>{syncJob.message}</span>
          {syncJob.status === 'running' ? (
            <button className="btn btn--text btn--sm" type="button" onClick={() => void cancelSync()}>Cancel</button>
          ) : (
            <button className="icon-btn icon-btn--sm" type="button" aria-label="Dismiss sync status" onClick={dismissSync}><X size={14} /></button>
          )}
        </div>
      )}

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
