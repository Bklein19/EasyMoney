import { useState } from 'react';
import { format } from 'date-fns';
import { Check, AlertTriangle } from 'lucide-react';
import { useAccounts } from '../../hooks/useAccounts';
import { useTransactions } from '../../hooks/useTransactions';
import { useImportProfiles } from '../../hooks/useImportProfiles';
import { isCreditAccount } from '../../utils/transactionSemantics';
import { getAccountTypeLabel } from '../../utils/formatters';
import { getHeaderSignature, getTransactionFingerprint, splitDuplicateTransactions } from '../../utils/importIdentity';
import './ImportPreview.css';

export default function ImportPreview({ transactions, importMeta, onComplete, onCancel }) {
  const { accounts, updateBalance } = useAccounts();
  const initialAccountId = importMeta?.savedImportProfile?.lastAccountId
    ? String(importMeta.savedImportProfile.lastAccountId)
    : '';
  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId);
  const { transactions: existingTransactions, addTransactionsBatch } = useTransactions(
    selectedAccountId ? { accountId: selectedAccountId } : {}
  );
  const { saveImportProfile } = useImportProfiles();
  const [isImporting, setIsImporting] = useState(false);
  const selectedAccount = accounts.find(a => a.id === Number(selectedAccountId));
  const importingToCreditCard = isCreditAccount(selectedAccount);

  // Filter out any invalid transactions just in case
  const validTransactions = transactions.filter(t => t && t.date && typeof t.amount === 'number');

  const creditCount = validTransactions.filter(t => t.amount > 0).length;
  const chargeCount = validTransactions.filter(t => t.amount < 0).length;
  const accountId = selectedAccountId ? Number(selectedAccountId) : null;
  const { unique, duplicates } = accountId
    ? splitDuplicateTransactions(validTransactions, existingTransactions, accountId)
    : { unique: validTransactions, duplicates: [] };
  const uniqueTotalAmount = unique.reduce((sum, t) => sum + t.amount, 0);

  const handleImport = async () => {
    if (!selectedAccountId) {
      alert("Please select an account to import these transactions into.");
      return;
    }
    
    setIsImporting(true);
    try {
      const accountId = Number(selectedAccountId);
      const account = accounts.find(a => a.id === accountId);
      const isCardImport = isCreditAccount(account);
      const importBatchId = [
        'import',
        accountId,
        validTransactions[0]?.date || 'unknown-start',
        validTransactions.at(-1)?.date || 'unknown-end',
        validTransactions.length
      ].join('-');
      
      const transactionsToImport = unique.map(t => ({
          ...t,
          accountId,
          importBatchId,
          transactionKind: isCardImport && t.amount > 0 ? 'card_payment' : t.transactionKind,
        }));

      if (transactionsToImport.length > 0) {
        await addTransactionsBatch(transactionsToImport);
      }

      // Update account balance
      if (account && transactionsToImport.length > 0) {
        const newBalance = (account.currentBalance || 0) + uniqueTotalAmount;
        await updateBalance(accountId, newBalance);
      }

      if (importMeta?.headers?.length && importMeta?.profile) {
        await saveImportProfile({
          headerSignature: getHeaderSignature(importMeta.headers),
          profileName: importMeta.profileName,
          profile: importMeta.profile,
          mapping: importMeta.mapping,
          lastAccountId: accountId
        });
      }

      onComplete(transactionsToImport.length, duplicates.length);
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
            {selectedAccountId && duplicates.length > 0 && ` ${duplicates.length} duplicate${duplicates.length === 1 ? '' : 's'} will be skipped.`}
          </p>
        </div>
        
        <div className="account-selector">
          <div className="account-selector__field">
            <label htmlFor="accountId">Import to Account:</label>
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
          </div>
          {selectedAccount && (
            <span className={`account-kind-badge ${importingToCreditCard ? 'credit' : ''}`}>
              {importingToCreditCard ? 'Credit card mode' : `${getAccountTypeLabel(selectedAccount.type)} mode`}
            </span>
          )}
        </div>
      </div>

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
            <div className="stat-value">{duplicates.length}</div>
          </div>
        )}
      </div>

      <div className="preview-table-container glass-card">
        <table className="preview-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>{importingToCreditCard ? 'Type' : 'Category (Auto)'}</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {validTransactions.slice(0, 50).map((t, i) => {
              const isDuplicate = accountId
                ? duplicates.some(duplicate => duplicate.fingerprint === getTransactionFingerprint(t, accountId))
                : false;

              return (
              <tr key={i} className={isDuplicate ? 'duplicate-row' : ''}>
                <td>{format(new Date(t.date), 'MMM d, yyyy')}</td>
                <td className="description-cell">{t.merchant || t.description}</td>
                <td>
                  {isDuplicate ? (
                    <span className="badge duplicate">Duplicate</span>
                  ) : importingToCreditCard && t.amount > 0 ? (
                    <span className="badge categorized">Card payment</span>
                  ) : t.categoryId ? (
                    <span className="badge categorized">Categorized</span>
                  ) : (
                    <span className="badge uncategorized">Uncategorized</span>
                  )}
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
          disabled={isImporting || !selectedAccountId || unique.length === 0}
        >
          {isImporting ? 'Importing...' : (
            <>
              <Check size={18} />
              Import {unique.length} Transaction{unique.length === 1 ? '' : 's'}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
