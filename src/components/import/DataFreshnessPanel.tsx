import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { AlertTriangle, ChevronDown, History, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { SyncJob } from '../../../server/app/dataSync/jobs.ts';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import { useAccounts, type AccountRow } from '../../hooks/useAccounts';
import { formatCurrency, formatDate } from '../../utils/formatters';
import type {
  SyncAccountClaim,
  SyncAccountMappingDecision,
  SyncArtifactReview,
  SyncRunReview,
  SyncTarget,
} from '../../../server/app/dataSync/types.ts';
import { syncArtifactSubtitle, syncArtifactTitle } from './syncArtifactLabels.ts';
import {
  syncAccountMappingWarning,
  syncClaimRequiresExplicitMapping,
} from '../../../server/app/dataSync/accountMapping.ts';
import {
  formatAccountMappingCandidate,
  applySyncGroupMappingChoice,
  groupSyncAccountClaims,
  syncAccountAggregateSummary,
  syncAccountGroupAutoDestination,
  syncAccountGroupClaim,
} from './syncAccountMapping.ts';

type FreshnessStatus = 'current' | 'due' | 'stale' | 'no-data' | 'closed' | 'on-demand';
interface FreshnessAccount {
  needsUpdate: boolean;
  accountId: number;
  accountName: string;
  institution: string | null;
  accountType: string;
  latestTransactionDate: string | null;
  latestBalanceDate: string | null;
  activityCheckedThrough: string | null;
  transactionStatus: FreshnessStatus;
  balanceStatus: FreshnessStatus;
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
    onDemandAccounts: number;
  };
  accounts: FreshnessAccount[];
}

interface SyncAccountDraft {
  name: string;
  institution: string;
  type: string;
  currency: string;
  accountHolder: string;
}

type SyncMappingChoice =
  | { mode: 'auto'; accountId: string; account: SyncAccountDraft }
  | { mode: 'needs-selection'; accountId: string; account: SyncAccountDraft }
  | { mode: 'existing'; accountId: string; account: SyncAccountDraft }
  | { mode: 'unarchive'; accountId: string; account: SyncAccountDraft }
  | { mode: 'create'; accountId: string; account: SyncAccountDraft };

type SyncMappingChoices = Record<string, SyncMappingChoice>;

function syncAccountDraft(claim: SyncAccountClaim): SyncAccountDraft {
  const name = claim.accountName && claim.accountName !== 'Selected account' ? claim.accountName : '';
  const normalized = `${name} ${claim.institution || ''}`.toLowerCase();
  return {
    name,
    institution: claim.institution || '',
    accountHolder: claim.accountHolder || '',
    type: /\b(credit|card|visa|mastercard|amex|discover)\b/.test(normalized)
      ? 'credit'
      : /\b(ira|roth|brokerage|investment|retirement|annuity)\b/.test(normalized)
        ? 'investment'
        : /\b(savings|save)\b/.test(normalized)
          ? 'savings'
          : 'checking',
    currency: 'USD',
  };
}

function initialSyncMappingChoice(claim: SyncAccountClaim): SyncMappingChoice {
  return claim.resolvedAccountId &&
    claim.resolution !== 'archived-match' &&
    claim.resolution !== 'ambiguous' &&
    !syncClaimRequiresExplicitMapping(claim)
    ? { mode: 'auto', accountId: String(claim.resolvedAccountId), account: syncAccountDraft(claim) }
    : { mode: 'needs-selection', accountId: '', account: syncAccountDraft(claim) };
}

function initialSyncGroupMappingChoice(claims: SyncAccountClaim[]): SyncMappingChoice {
  const representative = syncAccountGroupClaim(claims);
  if (syncAccountGroupAutoDestination(claims) === null) {
    return { mode: 'needs-selection', accountId: '', account: syncAccountDraft(representative) };
  }
  return initialSyncMappingChoice(representative);
}

function syncMappingChoiceComplete(choice: SyncMappingChoice | undefined, claim: SyncAccountClaim) {
  if (!choice) return false;
  if (choice.mode === 'auto') {
    return Boolean(claim.resolvedAccountId) &&
      claim.resolution !== 'archived-match' &&
      claim.resolution !== 'ambiguous' &&
      !syncClaimRequiresExplicitMapping(claim);
  }
  if (choice.mode === 'existing' || choice.mode === 'unarchive') return Boolean(choice.accountId);
  if (choice.mode === 'create') {
    return Boolean(
      choice.account.name.trim() &&
      choice.account.type &&
      choice.account.currency
    );
  }
  return false;
}

interface SyncActionMenuProps {
  icon: 'history' | 'refresh';
  label: string;
  primary?: boolean;
  targets: SyncTarget[];
  onSelect: (target: SyncTarget) => void;
}

function SyncActionMenu({ icon, label, primary = false, targets, onSelect }: SyncActionMenuProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const MenuIcon = icon === 'history' ? History : RefreshCw;

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

  if (targets.length === 0) return null;
  return (
    <details className={`data-freshness__sync-menu${primary ? ' is-primary' : ''}`} ref={detailsRef}>
      <summary>
        <MenuIcon size={14} />
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

function artifactCoverage(artifact: SyncArtifactReview) {
  if (!artifact.coveredFrom && !artifact.coveredTo) return 'No dated facts';
  if (artifact.coveredFrom === artifact.coveredTo) return formatFreshnessDate(artifact.coveredFrom);
  return `${formatFreshnessDate(artifact.coveredFrom)} – ${formatFreshnessDate(artifact.coveredTo)}`;
}

function syncArtifactNonMappingWarnings(artifact: SyncArtifactReview) {
  const mappingWarnings = new Set(artifact.accountClaims
    .map(syncAccountMappingWarning)
    .filter((warning): warning is string => Boolean(warning)));
  return artifact.warnings.filter(warning => !mappingWarnings.has(warning));
}

function SyncAccountMappingControl({
  claim,
  accounts,
  choice,
  onChange,
  allowCreate = true,
}: {
  claim: SyncAccountClaim;
  accounts: AccountRow[];
  choice: SyncMappingChoice;
  onChange: (choice: SyncMappingChoice) => void;
  allowCreate?: boolean;
}) {
  const activeAccounts = accounts.filter(account => account.status !== 'archived');
  const matchedAccount = accounts.find(account => account.id === claim.resolvedAccountId);
  const selectValue = choice.mode === 'existing'
    ? choice.accountId
    : choice.mode === 'unarchive'
      ? '__unarchive__'
      : choice.mode === 'create'
        ? '__create__'
        : choice.mode === 'auto'
          ? '__auto__'
          : '';
  const updateDraft = (field: keyof SyncAccountDraft, value: string) => onChange({
    ...choice,
    mode: 'create',
    account: { ...choice.account, [field]: value },
  });

  return (
    <div className="sync-review__mapping-control">
      <select
        className="form-input"
        aria-label={`Map ${claim.accountName || 'source account'}`}
        value={selectValue}
        onChange={event => {
          const value = event.target.value;
          if (value === '__auto__') {
            onChange({ ...choice, mode: 'auto', accountId: String(claim.resolvedAccountId || '') });
          } else if (value === '__unarchive__') {
            onChange({ ...choice, mode: 'unarchive', accountId: String(claim.resolvedAccountId || '') });
          } else if (value === '__create__') {
            onChange({ ...choice, mode: 'create', accountId: '' });
          } else if (value) {
            onChange({ ...choice, mode: 'existing', accountId: value });
          } else {
            onChange({ ...choice, mode: 'needs-selection', accountId: '' });
          }
        }}
      >
        <option value="">Choose destination account…</option>
        {claim.resolvedAccountId &&
          claim.resolution !== 'archived-match' &&
          claim.resolution !== 'ambiguous' &&
          !syncClaimRequiresExplicitMapping(claim) && (
          <option value="__auto__">
            Use matched account{matchedAccount ? `: ${formatAccountMappingCandidate(matchedAccount)}` : ''}
          </option>
        )}
        {claim.resolution === 'archived-match' && claim.resolvedAccountId && (
          <option value="__unarchive__">
            Unarchive and use {matchedAccount ? formatAccountMappingCandidate(matchedAccount) : 'matched account'}
          </option>
        )}
        {allowCreate && <option value="__create__">Create account from this download</option>}
        {activeAccounts.map(account => (
          <option key={account.id} value={account.id}>
            {formatAccountMappingCandidate(account)}
          </option>
        ))}
      </select>
      {choice.mode === 'create' && (
        <div className="sync-review__account-create">
          <input
            className="form-input"
            value={choice.account.name}
            onChange={event => updateDraft('name', event.target.value)}
            placeholder="Account name"
          />
          <input
            className="form-input"
            value={choice.account.institution}
            onChange={event => updateDraft('institution', event.target.value)}
            placeholder="Institution"
          />
          <select
            className="form-input"
            value={choice.account.type}
            onChange={event => updateDraft('type', event.target.value)}
          >
            <option value="checking">Checking</option>
            <option value="savings">Savings</option>
            <option value="credit">Credit Card</option>
            <option value="investment">Investment</option>
            <option value="loan">Loan</option>
            <option value="other">Other</option>
          </select>
          <input
            className="form-input"
            value={choice.account.accountHolder}
            onChange={event => updateDraft('accountHolder', event.target.value)}
            placeholder="Owner"
          />
          <select
            className="form-input"
            value={choice.account.currency}
            onChange={event => updateDraft('currency', event.target.value)}
          >
            <option value="USD">USD ($)</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
            <option value="CAD">CAD ($)</option>
          </select>
        </div>
      )}
    </div>
  );
}

function SyncArtifactDetails({
  artifact,
  initiallyOpen,
}: {
  artifact: SyncArtifactReview;
  initiallyOpen: boolean;
}) {
  const title = syncArtifactTitle(artifact);
  const subtitle = syncArtifactSubtitle(artifact);
  const warnings = syncArtifactNonMappingWarnings(artifact);
  return (
    <details className="sync-review__artifact" open={initiallyOpen}>
      <summary>
        <div className="sync-review__file">
          <strong>{title}</strong>
          {subtitle && <small>{subtitle}</small>}
        </div>
        <div className="sync-review__destination">
          <span>Import to</span>
          <strong>{artifact.accountName || (artifact.status === 'ready' ? 'Account mapping above' : 'Previously imported')}</strong>
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
        {warnings.length > 0 && (
          <div className="sync-review__warnings">
            {warnings.map(warning => (
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
                  <small>{claim.transactionCount} tx · {claim.balanceCount} bal</small>
                </div>
                <span>{artifact.status === 'ready' ? 'Uses mapping above' : claim.resolvedAccountName || 'Previously imported'}</span>
              </div>
            ))}
          </section>

          <section>
            <h4>Balance claims</h4>
            {artifact.balanceClaims.length > 0 ? artifact.balanceClaims.map((claim, index) => (
              <div className="sync-review__claim-row" key={`${claim.date}-${claim.account}-${index}`}>
                <div>
                  <strong>{formatFreshnessDate(claim.date)}</strong>
                  <small>{claim.account || artifact.accountName || 'Mapped source account'}</small>
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
                      <small>{claim.account || artifact.accountName || 'Mapped source account'}</small>
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

        <details className="sync-review__file-details">
          <summary>File details</summary>
          <dl>
            <dt>Original filename</dt>
            <dd>{artifact.fileName}</dd>
            <dt>Parser</dt>
            <dd>{artifact.parserLabel || artifact.parserName || 'Unknown parser'}</dd>
            {artifact.parserLabel && artifact.parserName && (
              <>
                <dt>Parser ID</dt>
                <dd>{artifact.parserName}</dd>
              </>
            )}
          </dl>
        </details>
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
  onConfirm: (accountMappings: SyncAccountMappingDecision[], outcomeRevision: string) => void;
  onDiscard: () => void;
}) {
  const { accounts } = useAccounts({ includeArchived: true });
  const readyClaims = useMemo(
    () => review.artifacts
      .filter(artifact => artifact.status === 'ready')
      .flatMap(artifact => artifact.accountClaims),
    [review.artifacts],
  );
  const readyClaimGroups = useMemo(() => {
    return groupSyncAccountClaims(readyClaims);
  }, [readyClaims]);
  const explicitMappingIdentityKeys = useMemo(() => new Set(
    readyClaimGroups
      .filter(group => syncAccountGroupAutoDestination(group.claims) === null)
      .map(group => group.identityKey),
  ), [readyClaimGroups]);
  const [mappingChoices, setMappingChoices] = useState<SyncMappingChoices>(() => Object.fromEntries(
    readyClaimGroups.map(group => [group.identityKey, initialSyncGroupMappingChoice(group.claims)]),
  ));
  useEffect(() => {
    setMappingChoices(Object.fromEntries(
      readyClaimGroups.map(group => [group.identityKey, initialSyncGroupMappingChoice(group.claims)]),
    ));
  }, [review.runId, readyClaimGroups]);
  const mappingsComplete = readyClaimGroups.every(group =>
    syncMappingChoiceComplete(mappingChoices[group.identityKey], syncAccountGroupClaim(group.claims))
  );
  const buildAccountMappings = (): SyncAccountMappingDecision[] => readyClaimGroups.map(group => {
    const claim = syncAccountGroupClaim(group.claims);
    const choice = mappingChoices[group.identityKey];
    if (!choice || !syncMappingChoiceComplete(choice, claim)) {
      throw new Error('Resolve every source account before confirming the catch-up.');
    }
    const last4 = claim.last4;
    if (choice.mode === 'auto') {
      return { sourceAccountId: claim.sourceAccountId, mode: 'auto', last4 };
    }
    if (choice.mode === 'existing') {
      return { sourceAccountId: claim.sourceAccountId, mode: 'existing', accountId: Number(choice.accountId), last4 };
    }
    if (choice.mode === 'unarchive') {
      return { sourceAccountId: claim.sourceAccountId, mode: 'unarchive', accountId: Number(choice.accountId), last4 };
    }
    if (choice.mode !== 'create') {
      throw new Error('Resolve every source account before confirming the catch-up.');
    }
    return {
      sourceAccountId: claim.sourceAccountId,
      mode: 'create',
      last4,
      account: {
        name: choice.account.name.trim(),
        institution: choice.account.institution.trim() || null,
        type: choice.account.type,
        currency: choice.account.currency,
        accountHolder: choice.account.accountHolder.trim() || null,
      },
    };
  });
  const readyArtifacts = review.artifacts.filter(artifact => artifact.status === 'ready');
  const skippedArtifacts = review.artifacts.filter(artifact => artifact.status !== 'ready');
  const outcomeMappings = mappingsComplete ? buildAccountMappings() : null;
  const outcomeQuery = useQuery({
    queryKey: ['sync-review-outcomes', review.runId, outcomeMappings],
    queryFn: () => trpcClient.dataSync.outcomes.query({ runId: review.runId, accountMappings: outcomeMappings }),
    enabled: mappingsComplete,
    staleTime: 0,
  });
  const outcomes = mappingsComplete ? outcomeQuery.data : undefined;
  const allAlreadyImported = review.artifacts.length > 0
    && outcomes?.nothingNew === true;
  const aggregateSummary = syncAccountAggregateSummary(readyClaims);
  const aggregateClaim = aggregateSummary ? {
    ...syncAccountGroupClaim(readyClaims),
    accountName: readyClaims[0]?.resolvedAccountName || 'Matched account',
  } : null;
  const aggregateChoice = readyClaimGroups[0] ? mappingChoices[readyClaimGroups[0].identityKey] : undefined;
  return (
    <section
      className="sync-review"
      aria-labelledby="sync-review-title"
      aria-busy={isWorking}
    >
      <div className="sync-review__header">
        <div>
          <span className="sync-review__state">Import review</span>
          <h3 id="sync-review-title">{!mappingsComplete ? 'Choose where to import' : allAlreadyImported ? 'Nothing new to import' : 'Review your import'}</h3>
          <p>{allAlreadyImported
            ? 'No new ledger transactions or balance changes. Confirmation may record supporting source files and account mappings.'
            : !mappingsComplete ? 'Choose the destination below. Then we’ll show what this import will change.'
            : 'Check the changes below. Your data stays unchanged until you confirm.'}</p>
        </div>
        <div className="sync-review__actions">
          <button className="btn btn--secondary btn--sm" type="button" disabled={isWorking} onClick={onDiscard}>Discard</button>
          <button
            className="btn btn--primary btn--sm"
            type="button"
            disabled={isWorking || !mappingsComplete || !outcomes?.canConfirm || outcomeQuery.isFetching || outcomeQuery.isError}
            onClick={() => outcomes && onConfirm(buildAccountMappings(), outcomes.revision)}
          >
            {isWorking && <LoaderCircle className="spin" size={14} />}
            {review.readyToImport > 0 ? 'Confirm import' : 'Finish'}
          </button>
        </div>
      </div>
      {mappingsComplete && <div className="sync-review__note" aria-live="polite">
        {!mappingsComplete ? 'Choose account mappings to calculate ledger changes.' : outcomeQuery.isError
          ? <>Ledger changes could not be calculated. Confirmation is paused. <button type="button" className="btn btn--secondary btn--sm" onClick={() => void outcomeQuery.refetch()}>Retry calculation</button></>
          : !outcomes || outcomeQuery.isFetching ? 'Calculating ledger changes…'
          : <>
            <h4>What will change</h4>
            <p className="sync-review__impact"><strong>{outcomes.transactions.new} new transactions</strong><span>{outcomes.transactions.represented} already in your ledger</span><span>{outcomes.transactions.ambiguous} need review</span></p>
            <p>{outcomes.balances.new + outcomes.balances.updated} balance updates · {outcomes.balances.unchanged} unchanged</p>
            {outcomes.transactions.excludedSummaries > 0 && <p>{outcomes.transactions.excludedSummaries} statement totals excluded from transactions.</p>}
            {outcomes.transactions.ambiguous > 0 && <p role="alert">Import paused: these overlaps are not proven duplicates. Compare the activity and statement source files and resolve their identities before importing. They will not be silently removed.</p>}
            {outcomes.balances.conflicting > 0 && <p role="alert">Import paused: equally authoritative balance claims disagree. Correct or exclude the conflicting source before importing; no balance is chosen arbitrarily.</p>}
            {Object.values(outcomes.historical).some(count => count > 0) && <section aria-label="Historical ledger impact">
              <strong>Existing ledger changes — separate from this import</strong>
              <p>The current rules would add {outcomes.historical.transactionsAdded}, remove {outcomes.historical.transactionsRemoved}, and change {outcomes.historical.transactionsChanged} existing transaction records, and change {outcomes.historical.balancesChanged} monthly balances.</p>
              <p>{outcomes.historical.ambiguousTransactions} historical transaction ambiguities; {outcomes.historical.conflictingBalances} historical balance conflicts.</p>
              <p role="alert">Import paused. These differences need a separate source audit and approved ledger reconciliation. Refreshing or confirming this import must not silently apply them. Your current ledger has not changed.</p>
            </section>}
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void outcomeQuery.refetch()}>Refresh ledger calculation</button>
          </>}
      </div>}
      {error && <p className="sync-review__error" role="alert">{error}</p>}
      {readyClaimGroups.length > 0 && (
        <details className="sync-review__mapping-groups" open={!mappingsComplete}>
          <summary>{mappingsComplete ? 'Destination accounts' : 'Choose destination account'} <span>· {aggregateSummary ? 1 : readyClaimGroups.length} account{!aggregateSummary && readyClaimGroups.length !== 1 ? 's' : ''}</span></summary>
          <div className="sync-review__mapping-groups-header">
            <div>
              <p>One choice applies to all files for that account.</p>
            </div>
          </div>
          {aggregateSummary && aggregateClaim && aggregateChoice && (
            <div className="sync-review__mapping-group">
              <div>
                <strong>{aggregateClaim.accountName}</strong>
                <small>{readyArtifacts.length} files · {aggregateSummary.transactionCount} tx · {aggregateSummary.balanceCount} bal</small>
                {aggregateSummary.latestBalanceDate && aggregateSummary.latestBalanceCents !== null && (
                  <small>Latest downloaded balance {formatCurrency(aggregateSummary.latestBalanceCents / 100)} on {formatFreshnessDate(aggregateSummary.latestBalanceDate)}</small>
                )}
                <small>One choice applies to all {readyClaimGroups.length} source identifiers below.</small>
              </div>
              <SyncAccountMappingControl
                claim={aggregateClaim}
                accounts={accounts}
                choice={aggregateChoice}
                allowCreate={false}
                onChange={next => setMappingChoices(previous => applySyncGroupMappingChoice(previous, readyClaimGroups, next))}
              />
            </div>
          )}
          {aggregateSummary ? (
            <details className="sync-review__source-identifiers">
              <summary><ChevronDown size={16} aria-hidden="true" /> Show source identifiers ({readyClaimGroups.length})</summary>
              <p>These identifiers belong to the group above. Its account choice applies to all of them.</p>
              <ul>{readyClaimGroups.map(group => (
                <li key={group.identityKey}>
                  <strong>{syncAccountGroupClaim(group.claims).accountName || 'Unidentified source'}</strong>
                  <span>{group.transactionCount} transactions · {group.balanceCount} balances</span>
                </li>
              ))}</ul>
            </details>
          ) : <>
          {readyClaimGroups.map(group => {
            const representative = syncAccountGroupClaim(group.claims);
            const mappingClaim = explicitMappingIdentityKeys.has(group.identityKey)
              ? { ...representative, requiresExplicitMapping: true }
              : representative;
            const choice = mappingChoices[group.identityKey] || initialSyncMappingChoice(mappingClaim);
            return (
              <div className="sync-review__mapping-group" key={group.identityKey}>
                <div>
                  <strong>{representative.accountName || 'Unidentified account'}</strong>
                  <small>{[representative.accountHolder, representative.institution].filter(Boolean).join(' · ') || 'No holder or institution stated'}</small>
                  <small>
                    {group.claims.length} file{group.claims.length === 1 ? '' : 's'} · {group.transactionCount} tx · {group.balanceCount} bal
                  </small>
                  <small>
                    {group.latestBalanceDate !== null && group.latestBalanceCents !== null
                      ? `Latest downloaded balance ${formatCurrency(group.latestBalanceCents / 100)} on ${formatFreshnessDate(group.latestBalanceDate)}`
                      : group.latestBalanceDate !== null
                        ? `Downloaded balances conflict on ${formatFreshnessDate(group.latestBalanceDate)}`
                        : 'No downloaded balance'}
                  </small>
                </div>
                <SyncAccountMappingControl
                  claim={mappingClaim}
                  accounts={accounts}
                  choice={choice}
                  onChange={next => setMappingChoices(previous => ({
                    ...previous,
                    [group.identityKey]: next,
                  }))}
                />
              </div>
            );
          })}
          </>}
        </details>
      )}
      <div className="sync-review__artifacts">
        {readyArtifacts.length > 0 && <h4 className="sync-review__files-heading">Files to review <span>{readyArtifacts.length}</span></h4>}
        {readyArtifacts.length > 0
          ? readyArtifacts.map(artifact => (
              <SyncArtifactDetails
                artifact={artifact}
                initiallyOpen={syncArtifactNonMappingWarnings(artifact).length > 0}
                key={`${artifact.importFileId}-${artifact.fileName}`}
              />
            ))
          : review.artifacts.length === 0 ? <p className="sync-review__empty-claim">No files were downloaded. Confirm to finish this catch-up without importing anything.</p> : null}
      </div>
      {skippedArtifacts.length > 0 && <details className="sync-review__skipped">
        <summary>{skippedArtifacts.length} file{skippedArtifacts.length === 1 ? '' : 's'} already imported <span>Skipped · no action needed</span></summary>
        {skippedArtifacts.map(artifact => <SyncArtifactDetails artifact={artifact} initiallyOpen={false} key={`${artifact.importFileId}-${artifact.fileName}`} />)}
      </details>}
    </section>
  );
}
interface DataFreshnessPanelProps {
  onImportComplete?: () => Promise<void> | void;
}

function SyncConnectionRun({ job, label, onImportComplete, onDismiss }: {
  job: SyncJob;
  label: string;
  onImportComplete?: () => Promise<void> | void;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.dataSync.jobs.queryKey() });
  const act = async (action: () => Promise<unknown>, committed = false) => {
    setBusy(true);
    setError('');
    try {
      await action();
      // A confirmed batch can change every other review's duplicate outcomes.
      await queryClient.invalidateQueries({ queryKey: ['sync-review-outcomes'] });
      if (committed) await onImportComplete?.();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Update failed');
      await queryClient.invalidateQueries({ queryKey: ['sync-review-outcomes'] });
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  const working = ['queued', 'running', 'importing'].includes(job.status);
  const reviewable = job.status === 'awaiting-confirmation' && job.review;
  return <article className="connection-run">
    <div className={`data-freshness__sync-status is-${job.status}`} role="status">
      {working && <LoaderCircle className="spin" size={15} />}
      <strong>{label}</strong>
      <span>{reviewable ? 'Ready to review' : job.message}</span>
      {['queued', 'running'].includes(job.status)
        ? <button className="btn btn--text btn--sm" disabled={busy} onClick={() => void act(() => trpcClient.dataSync.cancel.mutate({ runId: job.runId }))}>Cancel</button>
        : !working && !reviewable && <button className="icon-btn" aria-label={`Dismiss ${label} update`} onClick={onDismiss}><X size={14} /></button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {reviewable && <details className="connection-run__review">
      <summary>Review downloaded data</summary>
      <SyncReviewPanel
        review={job.review!}
        isWorking={busy}
        error={job.error || ''}
        onConfirm={(accountMappings, outcomeRevision) => void act(() => trpcClient.dataSync.confirm.mutate({ runId: job.runId, accountMappings, outcomeRevision }), true)}
        onDiscard={() => void act(() => trpcClient.dataSync.discard.mutate({ runId: job.runId }))}
      />
    </details>}
  </article>;
}

export default function DataFreshnessPanel({ onImportComplete }: DataFreshnessPanelProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const focusedAccountId = Number(searchParams.get('accountId')) || null;
  const [showAll, setShowAll] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('easymoney-dismissed-sync-runs') || '[]') as string[]; }
    catch { return []; }
  });
  const { accounts: accountMetadata } = useAccounts();
  const freshnessQuery = useQuery(trpc.dataFreshness.report.queryOptions());
  const targetsQuery = useQuery(trpc.dataSync.targets.queryOptions());
  const jobsQuery = useQuery({ ...trpc.dataSync.jobs.queryOptions(), refetchInterval: 1500 });
  const report = freshnessQuery.data as FreshnessReport | undefined;
  const targets = targetsQuery.data || [];
  const jobs = jobsQuery.data || [];
  const activeJobs = jobs.filter(job => ['queued', 'running', 'awaiting-confirmation', 'importing'].includes(job.status));
  const visibleJobs = jobs.filter(job => activeJobs.includes(job) || (!dismissed.includes(job.runId) && Date.now() - Date.parse(job.startedAt) < 86_400_000));
  const accounts = (report?.accounts || []).filter(account => !focusedAccountId || account.accountId === focusedAccountId);
  const needsAttention = (account: FreshnessAccount) => account.needsUpdate;
  const dueAccounts = accounts.filter(needsAttention);
  const visibleAccounts = showAll || focusedAccountId ? accounts : dueAccounts;
  const targetBusy = (target: SyncTarget) => activeJobs.some(job => job.institutionId === target.institutionId && (!job.connectionId || !target.connectionId || job.connectionId === target.connectionId));
  const dueTargets = targets.filter(target => target.accountIds?.some(id => dueAccounts.some(account => account.accountId === id)));
  const startTargets = async (selected: SyncTarget[], kind: 'current' | 'backfill') => {
    setStarting(true);
    setActionError('');
    const results = await Promise.allSettled(selected.filter(target => !targetBusy(target)).map(target => trpcClient.dataSync.start.mutate({
      institutionId: target.institutionId, connectionId: target.connectionId,
      goal: kind === 'current' ? { kind: 'current', overlapDays: 7 } : { kind: 'backfill' },
    })));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) setActionError(`${failures.length} update(s) could not start. ${failures.map(result => result.reason instanceof Error ? result.reason.message : 'Please try again.').join(' ')}`);
    await jobsQuery.refetch();
    setStarting(false);
  };
  const reason = (account: FreshnessAccount) => {
    if (account.status === 'closed') return 'Closed · no updates needed';
    if (account.status === 'on-demand') return 'No regular statements · reminders off';
    const reasons: string[] = [];
    if (account.transactionStatus !== 'current') reasons.push(account.activityCheckedThrough || account.latestTransactionDate
      ? `Activity through ${formatFreshnessDate(account.activityCheckedThrough || account.latestTransactionDate)}` : 'No activity imported');
    if (account.balanceStatus !== 'current') reasons.push(account.latestBalanceDate ? `Balance last reported ${formatFreshnessDate(account.latestBalanceDate)}` : 'No balance imported');
    return reasons.join(' · ') || 'Up to date';
  };
  return <section className="data-freshness" aria-label="Account updates">
    {visibleJobs.length > 0 && <section className="connection-runs" aria-label="Updates">
      <h2>Updates</h2>
      {visibleJobs.map(job => <SyncConnectionRun key={job.runId} job={job}
        label={targets.find(target => target.institutionId === job.institutionId && target.connectionId === job.connectionId)?.label || job.institutionId.replaceAll('-', ' ').replace(/\b\w/g, letter => letter.toUpperCase())}
        onImportComplete={onImportComplete}
        onDismiss={() => {
          const next = [...dismissed, job.runId];
          setDismissed(next);
          try { localStorage.setItem('easymoney-dismissed-sync-runs', JSON.stringify(next)); } catch { /* Optional preference. */ }
        }} />)}
    </section>}
    <div className="data-freshness__header">
      <div><h2>{dueAccounts.length ? 'Needs updating' : 'Account updates'}</h2>
        <p>{report ? dueAccounts.length ? `${dueAccounts.length} account${dueAccounts.length === 1 ? '' : 's'} need${dueAccounts.length === 1 ? 's' : ''} newer activity or balances.` : 'No scheduled updates due.' : 'Checking your accounts…'}</p>
      </div>
      <button className="btn btn-primary" disabled={starting || !dueTargets.some(target => !targetBusy(target))} onClick={() => void startTargets(dueTargets, 'current')}>
        <RefreshCw size={15} />Update due accounts
      </button>
    </div>
    {(actionError || freshnessQuery.error || jobsQuery.error || targetsQuery.error) && <p role="alert">{actionError || freshnessQuery.error?.message || jobsQuery.error?.message || targetsQuery.error?.message}</p>}
    {focusedAccountId && <button className="btn btn--text" onClick={() => setSearchParams({})}>Clear account filter</button>}
    <div className="connection-list">
      {targets.filter(target => target.accountIds?.some(id => visibleAccounts.some(account => account.accountId === id))).map(target => <div className="connection-group" key={target.id}>
        <h3>{target.label}</h3>
        <div className="connection-group__accounts">
        {visibleAccounts.filter(account => target.accountIds?.includes(account.accountId)).map(account => <div className="connection-account" key={account.accountId}>
          <span><strong>{account.accountName}</strong><small>{accountMetadata.find(item => item.id === account.accountId)?.accountHolder}</small></span>
          <span className={needsAttention(account) ? 'connection-account__reason' : ''}>{reason(account)}</span>
        </div>)}
        </div>
        <button className="btn btn-secondary btn--sm" disabled={starting || targetBusy(target)} onClick={() => void startTargets([target], 'current')}>{targetBusy(target) ? 'Update in progress' : 'Update'}</button>
      </div>)}
      {visibleAccounts.filter(account => !targets.some(target => target.accountIds?.includes(account.accountId))).map(account => <div className="connection-account" key={account.accountId}>
        <span><strong>{account.accountName}</strong><small>{account.institution} · {accountMetadata.find(item => item.id === account.accountId)?.accountHolder}</small></span>
        <span>{reason(account)}{needsAttention(account) && <small>Upload a statement or activity export</small>}</span>
      </div>)}
    </div>
    <div className="data-freshness__footer">
      <button className="btn btn--text btn--sm" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show only accounts needing updates' : `Show all ${accounts.length} accounts`}</button>
      <div className="data-freshness__sync-actions">
        <SyncActionMenu icon="refresh" label="Update a connection" targets={targets.filter(target => !targetBusy(target))} onSelect={target => void startTargets([target], 'current')} />
        <SyncActionMenu icon="history" label="Import older data" targets={targets.filter(target => !targetBusy(target))} onSelect={target => void startTargets([target], 'backfill')} />
      </div>
    </div>
  </section>;
}
