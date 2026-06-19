import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Check, AlertTriangle, Plus, X } from 'lucide-react';
import { useAccounts } from '../../hooks/useAccounts';
import { useTransactions } from '../../hooks/useTransactions';
import AddAccountModal from '../accounts/AddAccountModal';
import { apiAction } from '../../db/api';
import { isCreditAccount } from '../../utils/transactionSemantics';
import { getAccountTypeLabel } from '../../utils/formatters';
import { splitDuplicateTransactions } from '../../utils/importIdentity';
import './ImportPreview.css';

export default function ImportPreview({ transactions, importMeta, onComplete, onCancel }) {
  const { accounts } = useAccounts();
  const accountMappings = importMeta?.accountMappings || [];
  const initialAccountId = importMeta?.savedImportProfile?.lastAccountId
    ? String(importMeta.savedImportProfile.lastAccountId)
    : '';
  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId);
  const [sourceAccountSelections, setSourceAccountSelections] = useState(() => Object.fromEntries(
    accountMappings.map(mapping => [
      String(mapping.sourceAccountId),
      mapping.resolvedAccountId ? String(mapping.resolvedAccountId) : '__auto__',
    ])
  ));
  const [forceImportRowIds, setForceImportRowIds] = useState(() => new Set());
  const [isDuplicateModalOpen, setIsDuplicateModalOpen] = useState(false);
  const [isAddAccountOpen, setIsAddAccountOpen] = useState(false);
  const [duplicateModalSeenKey, setDuplicateModalSeenKey] = useState('');
  const { transactions: existingTransactions } = useTransactions(
    selectedAccountId ? { accountId: selectedAccountId } : {}
  );
  const [isImporting, setIsImporting] = useState(false);
  const selectedAccount = accounts.find(a => a.id === Number(selectedAccountId));
  const importingToCreditCard = isCreditAccount(selectedAccount);

  // Filter out any invalid transactions just in case
  const validTransactions = transactions.filter(t => t && t.date && typeof t.amount === 'number');

  const creditCount = validTransactions.filter(t => t.amount > 0).length;
  const chargeCount = validTransactions.filter(t => t.amount < 0).length;
  const parserIdentifiedAccounts = accountMappings.length > 0
    ? accountMappings.every(mapping => mapping.resolution !== 'selected-fallback' && mapping.resolution !== 'unresolved')
    : validTransactions.length > 0 && validTransactions.every(t => t.account || t.sourceAccountId);
  const mappingSelectionsComplete = accountMappings.every(mapping => {
    const selection = sourceAccountSelections[String(mapping.sourceAccountId)];
    return selection === '__auto__' || Boolean(selection);
  });
  const canResolveAccounts = Boolean(selectedAccountId) || (parserIdentifiedAccounts && mappingSelectionsComplete);
  const accountId = selectedAccountId ? Number(selectedAccountId) : null;
  const { unique, duplicates } = accountId
    ? splitDuplicateTransactions(validTransactions, existingTransactions, accountId)
    : { unique: validTransactions, duplicates: [] };
  const duplicateModalKey = `${accountId || 'none'}:${duplicates.map(duplicate => duplicate.importRowId).join(',')}`;
  const forcedDuplicates = duplicates.filter(duplicate => forceImportRowIds.has(duplicate.importRowId));
  const activeDuplicates = duplicates.filter(duplicate => !forceImportRowIds.has(duplicate.importRowId));
  const effectiveUnique = [...unique, ...forcedDuplicates];
  const activeDuplicateRowIds = new Set(activeDuplicates.map(duplicate => duplicate.importRowId));
  const uniqueTotalAmount = effectiveUnique.reduce((sum, t) => sum + t.amount, 0);
  const forcedDuplicateCount = forcedDuplicates.length;

  useEffect(() => {
    if (duplicates.length > 0 && duplicateModalKey !== duplicateModalSeenKey) {
      const timeoutId = window.setTimeout(() => {
        setIsDuplicateModalOpen(true);
        setDuplicateModalSeenKey(duplicateModalKey);
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [duplicates.length, duplicateModalKey, duplicateModalSeenKey]);

  const duplicateModalRows = duplicates.map(duplicate => ({
    ...duplicate,
    forceImport: forceImportRowIds.has(duplicate.importRowId),
  }));

  const toggleForceImport = (importRowId) => {
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

  const handleImport = async () => {
    if (!canResolveAccounts) {
      alert("Please select an account to import these transactions into.");
      return;
    }
    
    setIsImporting(true);
    try {
      const result = await apiAction('/app/imports/commit', {
        method: 'POST',
        body: JSON.stringify({
          accountId: selectedAccountId ? Number(selectedAccountId) : null,
          importFileId: importMeta?.importFileId,
          importRowIds: validTransactions.map(transaction => transaction.importRowId),
          forceImportRowIds: [...forceImportRowIds],
          accountMappings: accountMappings.map(mapping => {
            const selection = sourceAccountSelections[String(mapping.sourceAccountId)];
            return {
              sourceAccountId: mapping.sourceAccountId,
              accountId: selection && selection !== '__auto__' ? Number(selection) : null,
            };
          }),
          importMeta,
        })
      });
      onComplete(result.importedCount, result.skippedDuplicateCount);
    } catch (error) {
      console.error("Import error:", error);
      alert("An error occurred during import. Check console for details.");
    } finally {
      setIsImporting(false);
    }
  };

  if (validTransactions.length === 0) {
    return (
      <div className="import-preview glass-card empty">
        <AlertTriangle size={32} className="warning-icon" />
        <h2>No Valid Transactions Found</h2>
        <p>We couldn't parse any valid transactions from this file using the current configuration.</p>
        <button className="btn btn-primary" onClick={onCancel}>Go Back</button>
      </div>
    );
  }

  return (
    <div className="import-preview">
      <div className="preview-header glass-card">
        <div>
          <h2>Review Import</h2>
          <p>
            We found {validTransactions.length} transactions.
            {selectedAccountId && activeDuplicates.length > 0 && ` ${activeDuplicates.length} duplicate${activeDuplicates.length === 1 ? '' : 's'} will be skipped.`}
            {selectedAccountId && forcedDuplicateCount > 0 && ` ${forcedDuplicateCount} duplicate${forcedDuplicateCount === 1 ? '' : 's'} marked to import anyway.`}
          </p>
        </div>
        
        <div className="account-selector">
          <div className="account-selector__field">
            <label htmlFor="accountId">Import to Account:</label>
            <div className="account-selector__control">
              <select
                id="accountId"
                value={selectedAccountId}
                onChange={e => setSelectedAccountId(e.target.value)}
                className="form-input"
              >
                <option value="">-- Select an Account --</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({getAccountTypeLabel(a.type)})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary account-selector__add"
                onClick={() => setIsAddAccountOpen(true)}
              >
                <Plus size={16} />
                New Account
              </button>
            </div>
          </div>
          {selectedAccount && (
            <span className={`account-kind-badge ${importingToCreditCard ? 'credit' : ''}`}>
              {importingToCreditCard ? 'Credit card mode' : `${getAccountTypeLabel(selectedAccount.type)} mode`}
            </span>
          )}
          {!selectedAccount && parserIdentifiedAccounts && (
            <span className="account-kind-badge">
              Parser identified {accountMappings.length || new Set(validTransactions.map(t => `${t.institution || ''}|${t.account || ''}`)).size} account{(accountMappings.length || new Set(validTransactions.map(t => `${t.institution || ''}|${t.account || ''}`)).size) === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {accountMappings.length > 0 && (
        <div className="account-mapping-panel glass-card">
          <div className="account-mapping-panel__header">
            <h3>Account Mapping</h3>
          </div>
          <div className="account-mapping-list">
            {accountMappings.map(mapping => {
              const sourceName = mapping.sourceAccountName || 'Selected account';
              const institution = mapping.institution || 'Unknown institution';
              const selectionKey = String(mapping.sourceAccountId);
              const selection = sourceAccountSelections[selectionKey] || '__auto__';

              return (
                <div className="account-mapping-row" key={mapping.sourceAccountId}>
                  <div className="account-mapping-source">
                    <div className="account-mapping-name">{sourceName}</div>
                    <div className="account-mapping-meta">
                      {institution} | {mapping.transactionCount} transaction{mapping.transactionCount === 1 ? '' : 's'}
                      {mapping.balanceCount > 0 && ` | ${mapping.balanceCount} balance${mapping.balanceCount === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <select
                    value={selection}
                    onChange={event => setSourceAccountSelections(previous => ({
                      ...previous,
                      [selectionKey]: event.target.value,
                    }))}
                    className="form-input account-mapping-select"
                  >
                    <option value="__auto__">
                      {mapping.resolution === 'auto-create' ? 'Create or match automatically' : 'Use parser match'}
                    </option>
                    {accounts.map(account => (
                      <option key={account.id} value={account.id}>
                        {account.name} ({getAccountTypeLabel(account.type)})
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="preview-stats">
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
        {selectedAccountId && (
          <div className="stat-card glass-card">
            <div className="stat-label">Duplicates Skipped</div>
            <div className="stat-value">{activeDuplicates.length}</div>
          </div>
        )}
      </div>

      {selectedAccountId && duplicates.length > 0 && (
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
              const isDuplicate = accountId
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

      <div className="preview-actions">
        <button className="btn btn-secondary" onClick={onCancel} disabled={isImporting}>
          Cancel
        </button>
        <button 
          className="btn btn-primary" 
          onClick={handleImport} 
          disabled={isImporting || !canResolveAccounts || effectiveUnique.length === 0}
        >
          {isImporting ? 'Importing...' : (
            <>
              <Check size={18} />
              Import {effectiveUnique.length} Transaction{effectiveUnique.length === 1 ? '' : 's'}
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

      {isAddAccountOpen && (
        <AddAccountModal
          onClose={() => setIsAddAccountOpen(false)}
          onCreated={(id) => setSelectedAccountId(String(id))}
        />
      )}
    </div>
  );
}
