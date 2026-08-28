import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Check, AlertTriangle, X } from 'lucide-react';
import { useAccounts } from '../../hooks/useAccounts';
import { useTransactions } from '../../hooks/useTransactions';
import type { ImportPreviewResult } from '../../hooks/useCSVImport';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import { isCreditAccount } from '../../utils/accounts';
import { getAccountTypeLabel } from '../../utils/formatters';
import { splitDuplicateTransactions } from '../../utils/importIdentity';
import { formatAccountMappingCandidate } from './syncAccountMapping.ts';
import './ImportPreview.css';

const DEFAULT_ACCOUNT_TYPE = 'checking';
const DEFAULT_CURRENCY = 'USD';

type SourceAccountMapping = NonNullable<ImportPreviewResult['accountMappings']>[number];
type ImportPreviewTransaction = Record<string, unknown> & {
  importRowId: string | number;
  date: string;
  amount: number;
  description?: string | null;
  merchant?: string | null;
  originalDescription?: string | null;
  fingerprint?: string | null;
};

type ImportMeta = {
  importFileId?: string | number | null;
  headers?: string[];
  profile?: unknown;
  mapping?: unknown;
  profileName?: string | null;
  savedImportProfile?: unknown;
  accountMappings?: SourceAccountMapping[];
  balanceRowIds?: Array<string | number>;
};

interface AccountDraft {
  name: string;
  institution: string;
  type: string;
  currency: string;
  accountHolder: string;
}

type MappingDecision =
  | { mode: 'auto'; accountId: string; account: AccountDraft }
  | { mode: 'needs-selection'; accountId: string; account: AccountDraft }
  | { mode: 'existing'; accountId: string; account: AccountDraft }
  | { mode: 'unarchive'; accountId: string; account: AccountDraft }
  | { mode: 'create'; accountId: string; account: AccountDraft };

type MappingDecisions = Record<string, MappingDecision>;

interface ImportPreviewProps {
  transactions?: Array<Record<string, unknown> & { importRowId: string | number }>;
  importMeta?: ImportMeta | null;
  isBatchImport?: boolean;
  autoImportAll?: boolean;
  onStartAutoImportAll?: () => void;
  onAutoImportBlocked?: (message: string) => void;
  onComplete: (importedCount: number, skippedDuplicateCount?: number) => void | Promise<void>;
  onCancel: () => void;
}

function sourceAccountLabel(mapping: SourceAccountMapping) {
  return mapping.sourceAccountName && mapping.sourceAccountName !== 'Selected account'
    ? mapping.sourceAccountName
    : '';
}

function createDraftFromMapping(mapping: SourceAccountMapping): AccountDraft {
  const name = sourceAccountLabel(mapping);
  const normalized = `${name} ${mapping.institution || ''}`.toLowerCase();
  return {
    name,
    institution: mapping.institution || '',
    accountHolder: mapping.sourceAccountHolder || '',
    type: normalized.match(/\b(credit|card|visa|mastercard|amex|discover)\b/)
      ? 'credit'
      : normalized.match(/\b(ira|roth|brokerage|investment|merrill|robinhood|vanguard|retirement|annuity)\b/)
        ? 'investment'
        : DEFAULT_ACCOUNT_TYPE,
    currency: DEFAULT_CURRENCY,
  };
}

function initialDecision(mapping: SourceAccountMapping): MappingDecision {
  if (mapping.resolution === 'archived-match') {
    return {
      mode: 'needs-selection',
      accountId: mapping.resolvedAccountId ? String(mapping.resolvedAccountId) : '',
      account: createDraftFromMapping(mapping),
    };
  }
  if (mapping.resolvedAccountId) {
    return {
      mode: 'auto',
      accountId: String(mapping.resolvedAccountId),
      account: createDraftFromMapping(mapping),
    };
  }
  return {
    mode: 'needs-selection',
    accountId: '',
    account: createDraftFromMapping(mapping),
  };
}

function isDecisionComplete(decision: MappingDecision | undefined, mapping: SourceAccountMapping) {
  if (!decision) return false;
  if (decision.mode === 'auto') {
    return Boolean(mapping.resolvedAccountId) && mapping.resolution !== 'archived-match';
  }
  if (decision.mode === 'existing' || decision.mode === 'unarchive') {
    return Boolean(decision.accountId);
  }
  if (decision.mode === 'create') {
    return Boolean(
      decision.account?.name?.trim() &&
      decision.account?.type &&
      decision.account?.currency
    );
  }
  return false;
}

function selectedExistingAccountId(decision: MappingDecision | undefined, mapping: SourceAccountMapping) {
  if (!decision) return null;
  if (decision.mode === 'auto' && mapping.resolvedAccountId) return mapping.resolvedAccountId;
  if ((decision.mode === 'existing' || decision.mode === 'unarchive') && decision.accountId) {
    return Number(decision.accountId);
  }
  return null;
}

function previewStateKey(importMeta?: ImportMeta | null) {
  const mappings = importMeta?.accountMappings || [];
  return [
    importMeta?.importFileId || 'no-file',
    mappings.map(mapping => [
      mapping.sourceAccountId,
      mapping.resolution,
      mapping.resolvedAccountId || '',
      mapping.last4 || '',
    ].join(':')).join('|'),
  ].join(':');
}

function isValidImportTransaction(transaction: Record<string, unknown> & { importRowId: string | number }): transaction is ImportPreviewTransaction {
  return Boolean(transaction?.date && typeof transaction.amount === 'number');
}

function ImportPreviewContent({
  transactions = [],
  importMeta = null,
  isBatchImport = false,
  autoImportAll = false,
  onStartAutoImportAll,
  onAutoImportBlocked,
  onComplete,
  onCancel,
}: ImportPreviewProps) {
  const { accounts } = useAccounts({ includeArchived: true });
  const accountMappings = useMemo(() => importMeta?.accountMappings || [], [importMeta?.accountMappings]);
  const activeAccounts = accounts.filter(account => account.status !== 'archived');
  const [mappingDecisions, setMappingDecisions] = useState<MappingDecisions>(() => Object.fromEntries(
    accountMappings.map(mapping => [String(mapping.sourceAccountId), initialDecision(mapping)])
  ) as MappingDecisions);
  const [forceImportRowIds, setForceImportRowIds] = useState<Set<string | number>>(() => new Set());
  const [isDuplicateModalOpen, setIsDuplicateModalOpen] = useState(false);
  const [duplicateModalSeenKey, setDuplicateModalSeenKey] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  const validTransactions = transactions.filter(isValidImportTransaction);
  const balanceCount = importMeta?.balanceRowIds?.length || 0;
  const hasBalances = balanceCount > 0;
  const singleExistingAccountId = useMemo(() => {
    const ids = new Set(accountMappings
      .map(mapping => selectedExistingAccountId(mappingDecisions[String(mapping.sourceAccountId)], mapping))
      .filter((id): id is number => typeof id === 'number'));
    return ids.size === 1 ? [...ids][0] : null;
  }, [accountMappings, mappingDecisions]);
  const selectedAccount = accounts.find(account => account.id === singleExistingAccountId);
  const importingToCreditCard = isCreditAccount(selectedAccount);
  const {
    transactions: existingTransactions,
  } = useTransactions(
    singleExistingAccountId ? { accountId: singleExistingAccountId } : {}
  );

  const creditCount = validTransactions.filter(t => t.amount > 0).length;
  const chargeCount = validTransactions.filter(t => t.amount < 0).length;
  const mappingSelectionsComplete = accountMappings.length > 0 && accountMappings.every(mapping =>
    isDecisionComplete(mappingDecisions[String(mapping.sourceAccountId)], mapping)
  );
  const canAutoImportWithMatchedAccounts = accountMappings.length > 0 && accountMappings.every(mapping => {
    const decision = mappingDecisions[String(mapping.sourceAccountId)];
    return isDecisionComplete(decision, mapping);
  });
  const { unique, duplicates } = singleExistingAccountId
    ? splitDuplicateTransactions(validTransactions, existingTransactions, singleExistingAccountId)
    : { unique: validTransactions, duplicates: [] };
  const duplicateModalKey = `${singleExistingAccountId || 'none'}:${duplicates.map(duplicate => duplicate.importRowId).join(',')}`;
  const forcedDuplicates = duplicates.filter(duplicate => forceImportRowIds.has(duplicate.importRowId));
  const activeDuplicates = duplicates.filter(duplicate => !forceImportRowIds.has(duplicate.importRowId));
  const effectiveUnique = [...unique, ...forcedDuplicates];
  const activeDuplicateRowIds = new Set(activeDuplicates.map(duplicate => duplicate.importRowId));
  const uniqueTotalAmount = effectiveUnique.reduce((sum, t) => sum + t.amount, 0);
  const forcedDuplicateCount = forcedDuplicates.length;

  const invalidateImportDependents = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.imports.history.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.dataFreshness.report.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.accounts.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: ['app', 'transactions', 'infinite'] }),
      queryClient.invalidateQueries({ queryKey: trpc.netWorth.report.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.reports.netWorth.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.reports.savingsRate.queryKey() }),
    ]);
  };

  useEffect(() => {
    if (autoImportAll) return;
    if (duplicates.length > 0 && duplicateModalKey !== duplicateModalSeenKey) {
      const timeoutId = window.setTimeout(() => {
        setIsDuplicateModalOpen(true);
        setDuplicateModalSeenKey(duplicateModalKey);
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [autoImportAll, duplicates.length, duplicateModalKey, duplicateModalSeenKey]);

  const updateDecision = (sourceAccountId: string | number, nextDecision: MappingDecision) => {
    setMappingDecisions(previous => ({
      ...previous,
      [String(sourceAccountId)]: nextDecision,
    }));
  };

  const updateCreateDraft = (sourceAccountId: string | number, field: keyof AccountDraft, value: string) => {
    setMappingDecisions(previous => {
      const current = previous[String(sourceAccountId)];
      if (!current) return previous;
      return {
        ...previous,
        [String(sourceAccountId)]: {
          ...current,
          account: {
            ...(current?.account || {}),
            [field]: value,
          },
        },
      };
    });
  };

  const buildAccountMappingsPayload = () => accountMappings.map(mapping => {
    const decision = mappingDecisions[String(mapping.sourceAccountId)];
    if (!decision) {
      throw new Error('Resolve every source account before importing.');
    }
    const last4 = mapping.last4;
    if (decision.mode === 'auto') {
      return { sourceAccountId: mapping.sourceAccountId, mode: 'auto', last4 };
    }
    if (decision.mode === 'existing') {
      return {
        sourceAccountId: mapping.sourceAccountId,
        mode: 'existing',
        accountId: Number(decision.accountId),
        last4,
      };
    }
    if (decision.mode === 'unarchive') {
      return {
        sourceAccountId: mapping.sourceAccountId,
        mode: 'unarchive',
        accountId: Number(decision.accountId),
        last4,
      };
    }
    return {
      sourceAccountId: mapping.sourceAccountId,
      mode: 'create',
      last4,
      account: {
        name: decision.account.name.trim(),
        institution: decision.account.institution?.trim() || null,
        type: decision.account.type,
        currency: decision.account.currency,
        accountHolder: decision.account.accountHolder?.trim() || null,
      },
    };
  });

  const toggleForceImport = (importRowId: string | number) => {
    setForceImportRowIds(previous => {
      const next = new Set(previous);
      if (next.has(importRowId)) {
        next.delete(importRowId);
      } else {
        next.add(importRowId);
      }
      return next;
    });
  };

  const commitImport = async () => {
    if (!mappingSelectionsComplete) {
      alert('Resolve every source account before importing.');
      return;
    }

    setIsImporting(true);
    try {
      const accountMappings = buildAccountMappingsPayload();
      const result = await trpcClient.imports.commit.mutate({
        accountId: null,
        importFileId: importMeta?.importFileId,
        importRowIds: validTransactions.map(transaction => transaction.importRowId),
        forceImportRowIds: [...forceImportRowIds],
        balanceRowIds: importMeta?.balanceRowIds || [],
        accountMappings,
        importMeta: {
          ...importMeta,
          accountMappings,
        },
      });
      await invalidateImportDependents();
      await onComplete(result.importedCount, result.skippedDuplicateCount);
    } catch (error) {
      console.error('Import error:', error);
      alert(error instanceof Error ? error.message : 'An error occurred during import. Check console for details.');
    } finally {
      setIsImporting(false);
    }
  };

  const handleImport = async () => {
    await commitImport();
  };

  const handleImportAll = async () => {
    if (!canAutoImportWithMatchedAccounts) {
      onAutoImportBlocked?.('Choose an account for this file, then the batch can continue.');
      return;
    }
    onStartAutoImportAll?.();
  };

  if (validTransactions.length === 0 && !hasBalances) {
    return (
      <div className="import-preview glass-card empty">
        <AlertTriangle size={32} className="warning-icon" />
        <h2>No Valid Transactions Found</h2>
        <p>We couldn't parse any valid transactions from this file using the current configuration.</p>
        <button className="btn btn-primary" onClick={onCancel}>Go Back</button>
      </div>
    );
  }

  const duplicateModalRows = duplicates.map(duplicate => ({
    ...duplicate,
    forceImport: forceImportRowIds.has(duplicate.importRowId),
  }));

  return (
    <div className="import-preview">
      <div className="preview-header glass-card">
        <div>
          <h2>Review Import</h2>
          <p>
            We found {validTransactions.length} transactions.
            {hasBalances && ` We also found ${balanceCount} balance snapshot${balanceCount === 1 ? '' : 's'}.`}
            {singleExistingAccountId && activeDuplicates.length > 0 && ` ${activeDuplicates.length} duplicate${activeDuplicates.length === 1 ? '' : 's'} will be skipped.`}
            {singleExistingAccountId && forcedDuplicateCount > 0 && ` ${forcedDuplicateCount} duplicate${forcedDuplicateCount === 1 ? '' : 's'} marked to import anyway.`}
          </p>
        </div>

        <div className="account-selector">
          {selectedAccount && (
            <span className={`account-kind-badge ${importingToCreditCard ? 'credit' : ''}`}>
              {importingToCreditCard ? 'Credit card mode' : `${getAccountTypeLabel(selectedAccount.type)} mode`}
            </span>
          )}
          {!selectedAccount && mappingSelectionsComplete && (
            <span className="account-kind-badge">
              Source accounts resolved
            </span>
          )}
        </div>
      </div>

      <div className="account-mapping-panel glass-card">
        <div className="account-mapping-panel__header">
          <h3>Account Mapping</h3>
        </div>
        <div className="account-mapping-list">
          {accountMappings.map(mapping => {
            const sourceName = sourceAccountLabel(mapping) || 'Unidentified account';
            const institution = mapping.institution || 'Unknown institution';
            const selectionKey = String(mapping.sourceAccountId);
            const decision = mappingDecisions[selectionKey] || initialDecision(mapping);
            const matchedAccount = accounts.find(account => account.id === mapping.resolvedAccountId);
            const selectValue = decision.mode === 'existing'
              ? String(decision.accountId)
              : decision.mode === 'unarchive'
                ? '__unarchive__'
                : decision.mode === 'create'
                  ? '__create__'
                  : decision.mode === 'auto'
                    ? '__auto__'
                    : '';

            return (
              <div className="account-mapping-row" key={mapping.sourceAccountId}>
                <div className="account-mapping-source">
                  <div className="account-mapping-name">{sourceName}</div>
                  <div className="account-mapping-meta">
                    {institution} | {mapping.transactionCount} transaction{mapping.transactionCount === 1 ? '' : 's'}
                    {mapping.balanceCount > 0 && ` | ${mapping.balanceCount} balance${mapping.balanceCount === 1 ? '' : 's'}`}
                    {mapping.resolution === 'archived-match' && matchedAccount && ` | archived match: ${matchedAccount.name}`}
                  </div>
                </div>
                <div className="account-mapping-control">
                  <select
                    value={selectValue}
                    onChange={event => {
                      const value = event.target.value;
                      if (value === '__auto__') {
                        updateDecision(mapping.sourceAccountId, { ...decision, mode: 'auto', accountId: String(mapping.resolvedAccountId) });
                      } else if (value === '__unarchive__') {
                        updateDecision(mapping.sourceAccountId, { ...decision, mode: 'unarchive', accountId: String(mapping.resolvedAccountId) });
                      } else if (value === '__create__') {
                        updateDecision(mapping.sourceAccountId, { ...decision, mode: 'create', accountId: '' });
                      } else if (value) {
                        updateDecision(mapping.sourceAccountId, { ...decision, mode: 'existing', accountId: value });
                      } else {
                        updateDecision(mapping.sourceAccountId, { ...decision, mode: 'needs-selection' });
                      }
                    }}
                    className="form-input account-mapping-select"
                  >
                    <option value="">Choose account action</option>
                    {mapping.resolvedAccountId && mapping.resolution !== 'archived-match' && (
                      <option value="__auto__">
                        Use matched account{matchedAccount ? `: ${formatAccountMappingCandidate(matchedAccount)}` : ''}
                      </option>
                    )}
                    {mapping.resolution === 'archived-match' && mapping.resolvedAccountId && (
                      <option value="__unarchive__">
                        Unarchive and use {matchedAccount ? formatAccountMappingCandidate(matchedAccount) : 'matched account'}
                      </option>
                    )}
                    <option value="__create__">Create account from this import</option>
                    {activeAccounts.map(account => (
                      <option key={account.id} value={account.id}>
                        {formatAccountMappingCandidate(account)}
                      </option>
                    ))}
                  </select>
                  {decision.mode === 'create' && (
                    <div className="account-create-grid">
                      <input
                        className="form-input"
                        value={decision.account.name}
                        onChange={event => updateCreateDraft(mapping.sourceAccountId, 'name', event.target.value)}
                        placeholder="Account name"
                      />
                      <input
                        className="form-input"
                        value={decision.account.institution}
                        onChange={event => updateCreateDraft(mapping.sourceAccountId, 'institution', event.target.value)}
                        placeholder="Institution"
                      />
                      <select
                        className="form-input"
                        value={decision.account.type}
                        onChange={event => updateCreateDraft(mapping.sourceAccountId, 'type', event.target.value)}
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
                        value={decision.account.accountHolder}
                        onChange={event => updateCreateDraft(mapping.sourceAccountId, 'accountHolder', event.target.value)}
                        placeholder="Owner"
                      />
                      <select
                        className="form-input"
                        value={decision.account.currency}
                        onChange={event => updateCreateDraft(mapping.sourceAccountId, 'currency', event.target.value)}
                      >
                        <option value="USD">USD ($)</option>
                        <option value="EUR">EUR</option>
                        <option value="GBP">GBP</option>
                        <option value="CAD">CAD ($)</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="preview-stats">
        {hasBalances && (
          <div className="stat-card glass-card">
            <div className="stat-label">Balances Found</div>
            <div className="stat-value">{balanceCount}</div>
          </div>
        )}
        <div className="stat-card glass-card">
          <div className="stat-label">{importingToCreditCard ? 'Payments / Credits' : 'Income'}</div>
          <div className="stat-value positive">+{creditCount}</div>
        </div>
        <div className="stat-card glass-card">
          <div className="stat-label">{importingToCreditCard ? 'Card Charges' : 'Expenses'}</div>
          <div className="stat-value negative">-{chargeCount}</div>
        </div>
        <div className="stat-card glass-card">
          <div className="stat-label">{importingToCreditCard ? 'Balance Impact' : 'Net Impact'}</div>
          <div className={`stat-value ${uniqueTotalAmount >= 0 ? 'positive' : 'negative'}`}>
            {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(uniqueTotalAmount)}
          </div>
        </div>
        {singleExistingAccountId && (
          <div className="stat-card glass-card">
            <div className="stat-label">Duplicates Skipped</div>
            <div className="stat-value">{activeDuplicates.length}</div>
          </div>
        )}
      </div>

      {singleExistingAccountId && duplicates.length > 0 && (
        <div className="duplicate-review-callout glass-card">
          <div>
            <h3>Duplicate Review</h3>
            <p>
              {activeDuplicates.length} duplicate{activeDuplicates.length === 1 ? '' : 's'} will be skipped.
              {forcedDuplicateCount > 0 && ` ${forcedDuplicateCount} marked to import anyway.`}
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => setIsDuplicateModalOpen(true)}>
            Review duplicates
          </button>
        </div>
      )}

      {validTransactions.length > 0 ? (
        <div className="preview-table-container glass-card">
          <table className="preview-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Import Status</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {validTransactions.slice(0, 50).map((t, i) => {
                const isDuplicate = singleExistingAccountId
                  ? activeDuplicateRowIds.has(t.importRowId)
                  : false;
                const isForcedDuplicate = forceImportRowIds.has(t.importRowId);

                return (
                  <tr key={i} className={isDuplicate ? 'duplicate-row' : isForcedDuplicate ? 'forced-duplicate-row' : ''}>
                    <td>{format(new Date(t.date), 'MMM d, yyyy')}</td>
                    <td className="description-cell">{t.merchant || t.description}</td>
                    <td>
                      <span className={`badge ${isDuplicate ? 'duplicate' : isForcedDuplicate ? 'forced' : 'uncategorized'}`}>
                        {isDuplicate ? 'Duplicate' : isForcedDuplicate ? 'Import anyway' : 'Ready'}
                      </span>
                    </td>
                    <td className={`text-right font-medium ${t.amount >= 0 ? 'positive' : ''}`}>
                      {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(t.amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {validTransactions.length > 50 && (
            <div className="table-footer">
              Showing first 50 of {validTransactions.length} transactions.
            </div>
          )}
        </div>
      ) : (
        <div className="import-preview glass-card empty">
          <AlertTriangle size={32} className="warning-icon" />
          <h2>No Transactions Found</h2>
          <p>This statement only contains balance snapshots. You can still import the balances.</p>
        </div>
      )}

      <div className="preview-actions">
        <button className="btn btn-secondary" onClick={onCancel} disabled={isImporting}>
          Cancel
        </button>
        {isBatchImport && !autoImportAll && (
          <button
            className="btn btn-secondary"
            onClick={handleImportAll}
            disabled={isImporting || (effectiveUnique.length === 0 && !hasBalances)}
            title={!canAutoImportWithMatchedAccounts ? 'Resolve account mapping before importing all' : undefined}
          >
            Import All
          </button>
        )}
        <button
          className="btn btn-primary"
          onClick={handleImport}
          disabled={isImporting || !mappingSelectionsComplete || (effectiveUnique.length === 0 && !hasBalances)}
        >
          {isImporting ? 'Importing...' : (
            <>
              <Check size={18} />
              {effectiveUnique.length > 0
                ? `Import ${effectiveUnique.length} Transaction${effectiveUnique.length === 1 ? '' : 's'}`
                : `Import ${balanceCount} Balance${balanceCount === 1 ? '' : 's'}`}
            </>
          )}
        </button>
      </div>

      {isDuplicateModalOpen && (
        <div className="duplicate-modal-overlay" role="presentation">
          <div className="duplicate-modal" role="dialog" aria-modal="true" aria-labelledby="duplicate-modal-title">
            <div className="duplicate-modal__header">
              <div>
                <h3 id="duplicate-modal-title">Review Duplicates</h3>
                <p>Click any row to import it anyway.</p>
              </div>
              <button type="button" className="icon-button" aria-label="Close duplicate review" onClick={() => setIsDuplicateModalOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="duplicate-modal__list">
              {duplicateModalRows.map(duplicate => (
                <button
                  type="button"
                  key={duplicate.importRowId}
                  className={`duplicate-modal__row ${duplicate.forceImport ? 'selected' : ''}`}
                  onClick={() => toggleForceImport(duplicate.importRowId)}
                >
                  <div className="duplicate-modal__main">
                    <span>{format(new Date(duplicate.date), 'MMM d, yyyy')}</span>
                    <strong>{duplicate.merchant || duplicate.description}</strong>
                  </div>
                  <div className="duplicate-modal__side">
                    <span className={duplicate.amount >= 0 ? 'positive' : ''}>
                      {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(duplicate.amount)}
                    </span>
                    <span className={`badge ${duplicate.forceImport ? 'forced' : 'duplicate'}`}>
                      {duplicate.forceImport ? 'Import anyway' : 'Skip duplicate'}
                    </span>
                  </div>
                </button>
              ))}
            </div>
            <div className="duplicate-modal__footer">
              <span>{forcedDuplicateCount} selected to import</span>
              <button type="button" className="btn btn-primary" onClick={() => setIsDuplicateModalOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ImportPreview(props: ImportPreviewProps) {
  return <ImportPreviewContent key={previewStateKey(props.importMeta)} {...props} />;
}
