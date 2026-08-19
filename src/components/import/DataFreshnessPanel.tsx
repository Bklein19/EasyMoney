import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, CircleDashed, Clock3, History, LoaderCircle, Lock, RefreshCw, X } from 'lucide-react';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import { formatCurrency, formatDate } from '../../utils/formatters';
import type { SyncArtifactReview, SyncRunReview, SyncTarget } from '../../../server/app/dataSync/types.ts';

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

interface SyncActionMenuProps {
  targets: SyncTarget[];
  onSelect: (target: SyncTarget) => void;
}

function SyncActionMenu({ targets, onSelect }: SyncActionMenuProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const label = 'Import history';

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
    <details className="data-freshness__sync-menu" ref={detailsRef}>
      <summary>
        <History size={14} />
        {label}
        <ChevronDown className="data-freshness__sync-chevron" size={14} />
      </summary>
      <div className="data-freshness__sync-menu-panel" role="menu" aria-label={`${label} institution`}>
        {targets.map(target => (
          <button
            key={target.id}
            type="button"
            role="menuitem"
            onClick={() => {
              detailsRef.current?.removeAttribute('open');
              onSelect(target);
            }}
          >
            {target.label}
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

function artifactCoverage(artifact: SyncArtifactReview) {
  if (!artifact.coveredFrom && !artifact.coveredTo) return 'No dated facts';
  if (artifact.coveredFrom === artifact.coveredTo) return formatFreshnessDate(artifact.coveredFrom);
  return `${formatFreshnessDate(artifact.coveredFrom)} – ${formatFreshnessDate(artifact.coveredTo)}`;
}

function sourceTypeLabel(value: string | null) {
  return value ? value.replaceAll('-', ' ') : 'Unknown source type';
}

function SyncArtifactDetails({ artifact, initiallyOpen }: { artifact: SyncArtifactReview; initiallyOpen: boolean }) {
  return (
    <details className="sync-review__artifact" open={initiallyOpen}>
      <summary>
        <div className="sync-review__file">
          <strong>{artifact.fileName}</strong>
          <small>{artifact.parserName || 'Unknown parser'} · {sourceTypeLabel(artifact.sourceType)}</small>
        </div>
        <div className="sync-review__destination">
          <span>Import to</span>
          <strong>{artifact.accountName}</strong>
        </div>
        <div className="sync-review__coverage">
          <span>Coverage</span>
          <strong>{artifactCoverage(artifact)}</strong>
        </div>
        <div className="sync-review__counts">
          <strong>{artifact.transactionCount}</strong> transactions
          <span>·</span>
          <strong>{artifact.balanceCount}</strong> balances
        </div>
        {artifact.status === 'already-imported' && <span className="sync-review__duplicate">Already imported</span>}
        <ChevronDown className="sync-review__artifact-chevron" size={16} />
      </summary>

      <div className="sync-review__artifact-body">
        {artifact.warnings.length > 0 && (
          <div className="sync-review__warnings">
            {artifact.warnings.map(warning => (
              <p key={warning}><AlertTriangle size={14} />{warning}</p>
            ))}
          </div>
        )}

        <div className="sync-review__claim-grid">
          <section>
            <h4>Account claims</h4>
            {artifact.accountClaims.map(claim => (
              <div className="sync-review__claim-row" key={claim.sourceAccountId}>
                <div>
                  <strong>{claim.accountName || 'Unidentified account'}</strong>
                  <small>{[claim.accountHolder, claim.institution].filter(Boolean).join(' · ') || 'No holder or institution stated'}</small>
                </div>
                <span>{claim.transactionCount} tx · {claim.balanceCount} bal</span>
              </div>
            ))}
          </section>

          <section>
            <h4>Balance claims</h4>
            {artifact.balanceClaims.length > 0 ? artifact.balanceClaims.map((claim, index) => (
              <div className="sync-review__claim-row" key={`${claim.date}-${claim.account}-${index}`}>
                <div>
                  <strong>{formatFreshnessDate(claim.date)}</strong>
                  <small>{claim.account || artifact.accountName}</small>
                </div>
                <span className="num">{formatCurrency(claim.balanceCents / 100)}</span>
              </div>
            )) : <p className="sync-review__empty-claim">No balances in this artifact.</p>}
            {artifact.balanceCount > artifact.balanceClaims.length && (
              <small>Showing {artifact.balanceClaims.length} of {artifact.balanceCount} balances.</small>
            )}
          </section>
        </div>

        {artifact.transactionCount > 0 && (
          <section className="sync-review__transactions">
            <div className="sync-review__transactions-header">
              <h4>Transaction sample</h4>
              <div>
                <span>In {formatCurrency(artifact.inflowCents / 100)}</span>
                <span>Out {formatCurrency(artifact.outflowCents / 100)}</span>
                <span>Net {formatCurrency(artifact.netAmountCents / 100, true)}</span>
              </div>
            </div>
            <table>
              <tbody>
                {artifact.transactionSamples.map((claim, index) => (
                  <tr key={`${claim.date}-${claim.description}-${claim.amountCents}-${index}`}>
                    <td>{formatFreshnessDate(claim.date)}</td>
                    <td>
                      <strong>{claim.description}</strong>
                      <small>{claim.account || artifact.accountName}</small>
                    </td>
                    <td className="num">{formatCurrency(claim.amountCents / 100, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {artifact.transactionCount > artifact.transactionSamples.length && (
              <small>Showing {artifact.transactionSamples.length} of {artifact.transactionCount} transactions.</small>
            )}
          </section>
        )}
      </div>
    </details>
  );
}

function SyncReviewPanel({
  review,
  isWorking,
  error,
  onConfirm,
  onDiscard,
}: {
  review: SyncRunReview;
  isWorking: boolean;
  error: string;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const transactionCount = review.artifacts.reduce((sum, artifact) => sum + artifact.transactionCount, 0);
  const balanceCount = review.artifacts.reduce((sum, artifact) => sum + artifact.balanceCount, 0);
  return (
    <section className="sync-review" aria-label="Review downloaded data">
      <div className="sync-review__header">
        <div>
          <h3>Review downloaded data</h3>
          <p>Nothing changes in your ledger until you confirm.</p>
        </div>
        <div className="sync-review__totals">
          <span><strong>{review.artifacts.length}</strong> files</span>
          <span><strong>{transactionCount}</strong> transactions</span>
          <span><strong>{balanceCount}</strong> balances</span>
        </div>
        <div className="sync-review__actions">
          <button className="btn btn--secondary btn--sm" type="button" disabled={isWorking} onClick={onDiscard}>Discard</button>
          <button className="btn btn--primary btn--sm" type="button" disabled={isWorking} onClick={onConfirm}>
            {isWorking && <LoaderCircle className="spin" size={14} />}
            {review.readyToImport > 0 ? 'Confirm import' : 'Finish'}
          </button>
        </div>
      </div>
      {review.alreadyImported > 0 && (
        <p className="sync-review__note">
          {review.alreadyImported} downloaded file{review.alreadyImported === 1 ? ' is' : 's are'} already in the ledger and will be skipped.
        </p>
      )}
      {error && <p className="sync-review__error">{error}</p>}
      <div className="sync-review__artifacts">
        {review.artifacts.length > 0
          ? review.artifacts.map((artifact, index) => (
              <SyncArtifactDetails
                artifact={artifact}
                initiallyOpen={review.artifacts.length === 1 || artifact.warnings.length > 0 || index === 0}
                key={`${artifact.importFileId}-${artifact.fileName}`}
              />
            ))
          : <p className="sync-review__empty-claim">No files were downloaded. Confirm to finish this catch-up without importing anything.</p>}
      </div>
    </section>
  );
}

interface DataFreshnessPanelProps {
  onImportComplete?: () => Promise<void> | void;
}

export default function DataFreshnessPanel({ onImportComplete }: DataFreshnessPanelProps) {
  const [syncRunId, setSyncRunId] = useState(() => localStorage.getItem('easymoney-active-sync-run') || '');
  const [syncAction, setSyncAction] = useState<'confirm' | 'discard' | ''>('');
  const [syncActionError, setSyncActionError] = useState('');
  const freshnessQuery = useQuery(trpc.dataFreshness.report.queryOptions());
  const syncTargetsQuery = useQuery(trpc.dataSync.targets.queryOptions());
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
  const syncTargets = (syncTargetsQuery.data ?? []) as SyncTarget[];
  const syncIsActive = syncJob?.status === 'running' || syncJob?.status === 'importing' || syncJob?.status === 'awaiting-confirmation';

  useEffect(() => {
    if (!syncJob || syncJob.status !== 'complete') return;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.dataFreshness.report.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.imports.history.queryKey() }),
    ]);
  }, [syncJob?.status]);

  const startInstitutionSync = async (
    target: SyncTarget,
    kind: 'current' | 'backfill',
  ) => {
    const goal = kind === 'current'
      ? { kind: 'current' as const, overlapDays: 7 }
      : { kind: 'backfill' as const };
    setSyncActionError('');
    const job = await trpcClient.dataSync.start.mutate({
      institutionId: target.institutionId,
      connectionId: target.connectionId,
      goal,
    });
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

  const confirmSync = async () => {
    if (!syncRunId) return;
    setSyncAction('confirm');
    setSyncActionError('');
    try {
      await trpcClient.dataSync.confirm.mutate({ runId: syncRunId });
      await onImportComplete?.();
      await syncQuery.refetch();
    } catch (actionError) {
      setSyncActionError(actionError instanceof Error ? actionError.message : 'Import failed');
      await syncQuery.refetch();
    } finally {
      setSyncAction('');
    }
  };

  const discardSync = async () => {
    if (!syncRunId) return;
    setSyncAction('discard');
    setSyncActionError('');
    try {
      await trpcClient.dataSync.discard.mutate({ runId: syncRunId });
      await syncQuery.refetch();
    } catch (actionError) {
      setSyncActionError(actionError instanceof Error ? actionError.message : 'Could not discard downloaded data');
    } finally {
      setSyncAction('');
    }
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
          {syncTargets.length > 0 && !syncIsActive && (
            <div className="data-freshness__sync-actions">
              <SyncActionMenu
                targets={syncTargets}
                onSelect={target => void startInstitutionSync(target, 'backfill')}
              />
              {syncTargets.map(target => (
                <button
                  className="btn btn--primary btn--sm"
                  key={target.id}
                  type="button"
                  onClick={() => void startInstitutionSync(target, 'current')}
                >
                  <RefreshCw size={14} />
                  Catch up {target.label}
                </button>
              ))}
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

      {syncJob && syncJob.status !== 'awaiting-confirmation' && (
        <div className={`data-freshness__sync-status is-${syncJob.status}`} role="status">
          {(syncJob.status === 'running' || syncJob.status === 'importing') && <LoaderCircle className="spin" size={15} />}
          <span>{syncJob.message}</span>
          {syncJob.status === 'running' ? (
            <button className="btn btn--text btn--sm" type="button" onClick={() => void cancelSync()}>Cancel</button>
          ) : syncJob.status === 'importing' ? null : (
            <button className="icon-btn icon-btn--sm" type="button" aria-label="Dismiss sync status" onClick={dismissSync}><X size={14} /></button>
          )}
        </div>
      )}

      {syncJob?.status === 'awaiting-confirmation' && syncJob.review && (
        <SyncReviewPanel
          review={syncJob.review}
          isWorking={Boolean(syncAction)}
          error={syncActionError || syncJob.error || ''}
          onConfirm={() => void confirmSync()}
          onDiscard={() => void discardSync()}
        />
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
