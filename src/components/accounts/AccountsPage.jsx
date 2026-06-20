import { Fragment, useMemo, useState } from 'react';
import { Archive, Check, ChevronRight, RotateCcw } from 'lucide-react';
import { useAccounts } from '../../hooks/useAccounts';
import { formatCurrency, formatDate, getAccountTypeLabel } from '../../utils/formatters';
import './AccountsPage.css';

const ACCOUNT_TYPES = ['checking', 'savings', 'credit-card', 'investment', 'cash', 'other'];
const CURRENCIES = ['USD'];

const displayType = (type) => getAccountTypeLabel(type === 'credit-card' ? 'credit' : type);

function AccountDetails({ account, onSave, onArchiveToggle, isSaving, error }) {
  const [draft, setDraft] = useState({
    name: account.name || '',
    institution: account.institution || '',
    type: account.type || 'other',
    currency: account.currency || 'USD',
    accountHolder: account.accountHolder || '',
  });

  const isArchived = account.status === 'archived';
  const isDirty =
    draft.name.trim() !== (account.name || '') ||
    draft.institution.trim() !== (account.institution || '') ||
    draft.type !== (account.type || 'other') ||
    draft.currency !== (account.currency || 'USD') ||
    draft.accountHolder.trim() !== (account.accountHolder || '');

  const updateDraft = (field, value) => {
    setDraft(current => ({ ...current, [field]: value }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    onSave({
      name: draft.name.trim(),
      institution: draft.institution.trim() || null,
      type: draft.type,
      currency: draft.currency,
      accountHolder: draft.accountHolder.trim() || null,
    });
  };

  return (
    <div className="account-details-panel" onClick={(event) => event.stopPropagation()}>
      <form className="account-meta-form" onSubmit={handleSubmit}>
        <div className="account-field account-field--wide">
          <label htmlFor={`account-name-${account.id}`}>Name</label>
          <input
            id={`account-name-${account.id}`}
            value={draft.name}
            onChange={(event) => updateDraft('name', event.target.value)}
            disabled={isSaving}
          />
        </div>

        <div className="account-field account-field--wide">
          <label htmlFor={`account-holder-${account.id}`}>Owner</label>
          <input
            id={`account-holder-${account.id}`}
            value={draft.accountHolder}
            placeholder="No owner"
            onChange={(event) => updateDraft('accountHolder', event.target.value)}
            disabled={isSaving}
          />
        </div>

        <div className="account-field account-field--wide">
          <label htmlFor={`account-institution-${account.id}`}>Institution</label>
          <input
            id={`account-institution-${account.id}`}
            value={draft.institution}
            placeholder="No institution"
            onChange={(event) => updateDraft('institution', event.target.value)}
            disabled={isSaving}
          />
        </div>

        <div className="account-field">
          <label htmlFor={`account-type-${account.id}`}>Type</label>
          <select
            id={`account-type-${account.id}`}
            value={draft.type}
            onChange={(event) => updateDraft('type', event.target.value)}
            disabled={isSaving}
          >
            {ACCOUNT_TYPES.map(type => (
              <option key={type} value={type}>{displayType(type)}</option>
            ))}
          </select>
        </div>

        <div className="account-field">
          <label htmlFor={`account-currency-${account.id}`}>Currency</label>
          <select
            id={`account-currency-${account.id}`}
            value={draft.currency}
            onChange={(event) => updateDraft('currency', event.target.value)}
            disabled={isSaving}
          >
            {CURRENCIES.map(currency => (
              <option key={currency} value={currency}>{currency}</option>
            ))}
          </select>
        </div>

        <div className="account-details-actions">
          <button
            className="btn btn--primary btn--sm"
            type="submit"
            disabled={isSaving || !draft.name.trim() || !isDirty}
          >
            <Check size={14} />
            Save
          </button>
          <button
            className="btn btn--secondary btn--sm"
            type="button"
            onClick={onArchiveToggle}
            disabled={isSaving}
          >
            {isArchived ? <RotateCcw size={14} /> : <Archive size={14} />}
            {isArchived ? 'Unarchive' : 'Archive'}
          </button>
        </div>

        {error && <div className="account-details-error">{error}</div>}
      </form>
      {account.aliases?.length > 0 && (
        <div className="account-aliases">
          <div className="account-aliases__title">Aliases</div>
          <div className="account-aliases__chips">
            {account.aliases.map(alias => (
              <span className="account-alias-chip" key={alias.id} title={`${alias.institution}: ${alias.alias}`}>
                <span>{alias.institution}</span>
                {alias.alias}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AccountsPage() {
  const { accounts, updateAccount, archiveAccount, unarchiveAccount, isLoading } = useAccounts({ includeArchived: true });
  const [expandedAccountId, setExpandedAccountId] = useState(null);
  const [savingAccountId, setSavingAccountId] = useState(null);
  const [errorByAccountId, setErrorByAccountId] = useState({});

  const activeAccounts = useMemo(
    () => accounts.filter(account => account.status !== 'archived'),
    [accounts]
  );
  const totalBalance = useMemo(
    () => activeAccounts.reduce((sum, account) => sum + (account.currentBalance || 0), 0),
    [activeAccounts]
  );

  const setAccountError = (accountId, message) => {
    setErrorByAccountId(current => ({ ...current, [accountId]: message }));
  };

  const saveAccount = async (account, changes) => {
    setSavingAccountId(account.id);
    setAccountError(account.id, '');

    try {
      await updateAccount(account.id, changes);
    } catch (saveError) {
      setAccountError(account.id, saveError?.message || 'Could not update account.');
    } finally {
      setSavingAccountId(null);
    }
  };

  const toggleArchive = async (account) => {
    const isArchived = account.status === 'archived';
    const confirmed = window.confirm(isArchived
      ? `Unarchive ${account.name}? It will be available for imports and reports again.`
      : `Archive ${account.name}? Source facts and annotations will be preserved.`);
    if (!confirmed) return;

    setSavingAccountId(account.id);
    setAccountError(account.id, '');

    try {
      if (isArchived) {
        await unarchiveAccount(account.id);
      } else {
        await archiveAccount(account.id);
      }
    } catch (archiveError) {
      setAccountError(account.id, archiveError?.message || 'Could not update archive status.');
    } finally {
      setSavingAccountId(null);
    }
  };

  return (
    <div className="page accounts-page">
      <header className="page__header accounts-page__header">
        <div>
          <h1 className="page__title">
            Accounts <span className="accounts-page__count">{accounts.length} · {formatCurrency(totalBalance)}</span>
          </h1>
          <p className="page__subtitle">Manage imported account metadata and archive status.</p>
        </div>
      </header>

      <div className="accounts-table-wrap">
        {isLoading ? (
          <div className="empty-state-simple">Loading accounts...</div>
        ) : accounts.length === 0 ? (
          <div className="empty-state-simple">No accounts yet. Import a file to create or match an account.</div>
        ) : (
          <table className="accounts-table">
            <colgroup>
              <col className="accounts-table__account" />
              <col className="accounts-table__type" />
              <col className="accounts-table__status" />
              <col className="accounts-table__balance" />
              <col className="accounts-table__updated" />
              <col className="accounts-table__action" />
            </colgroup>
            <thead>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th>Status</th>
                <th className="num">Balance</th>
                <th>Updated</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {accounts.map(account => {
                const isExpanded = expandedAccountId === account.id;
                const isArchived = account.status === 'archived';
                const isSaving = savingAccountId === account.id;
                const latestBalanceDate = account.latestBalanceMonth || (account.updatedAt ? formatDate(account.updatedAt, 'iso') : '—');

                return (
                  <Fragment key={account.id}>
                    <tr
                      className={`account-row ${isExpanded ? 'is-expanded' : ''} ${isArchived ? 'is-archived' : ''} ${account.isClosed ? 'is-closed' : ''}`}
                      onClick={() => setExpandedAccountId(isExpanded ? null : account.id)}
                    >
                      <td>
                        <div className="account-row__name" title={account.name}>
                          <span>{account.name}</span>
                          {account.accountHolder && <span className="account-owner-badge">{account.accountHolder}</span>}
                          {account.isClosed && <span className="account-closed-badge">Closed</span>}
                        </div>
                        <div className="account-row__institution">{account.institution || 'No institution'}</div>
                      </td>
                      <td><span className="account-chip">{displayType(account.type)}</span></td>
                      <td>
                        <span className={`account-status-chip ${isArchived ? 'is-archived' : ''}`}>
                          {isArchived ? 'Archived' : account.isClosed ? 'Closed' : 'Active'}
                        </span>
                      </td>
                      <td className={`account-row__balance ${account.currentBalance < 0 ? 'is-negative' : ''}`}>
                        {formatCurrency(account.currentBalance || 0)}
                      </td>
                      <td className="account-row__updated">{latestBalanceDate}</td>
                      <td className="account-row__disclosure">
                        <button
                          className="icon-btn account-expand-btn"
                          type="button"
                          aria-label={isExpanded ? 'Close account details' : 'Open account details'}
                          aria-expanded={isExpanded}
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedAccountId(isExpanded ? null : account.id);
                          }}
                        >
                          <ChevronRight size={15} />
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="account-details-row">
                        <td colSpan={6}>
                          <AccountDetails
                            key={`${account.id}-${account.updatedAt ?? ''}-${account.status}`}
                            account={account}
                            onSave={(changes) => saveAccount(account, changes)}
                            onArchiveToggle={() => toggleArchive(account)}
                            isSaving={isSaving}
                            error={errorByAccountId[account.id]}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
