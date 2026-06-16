import { useState } from 'react';
import { Building2, Check, CreditCard, Edit3, Landmark, PiggyBank, X } from 'lucide-react';
import { useAccounts } from '../../hooks/useAccounts';
import { getAccountTypeLabel } from '../../utils/formatters';
import './AccountCard.css';

const getAccountIcon = (type) => {
  switch (type?.toLowerCase()) {
    case 'checking': return <Landmark size={24} className="account-icon checking" />;
    case 'savings': return <PiggyBank size={24} className="account-icon savings" />;
    case 'credit': return <CreditCard size={24} className="account-icon credit" />;
    case 'investment': return <Building2 size={24} className="account-icon investment" />;
    default: return <Landmark size={24} className="account-icon default" />;
  }
};

export default function AccountCard({ account }) {
  const { updateAccount } = useAccounts();
  const [isEditing, setIsEditing] = useState(false);
  const [draftName, setDraftName] = useState(account.name || '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const handleStartEdit = () => {
    setDraftName(account.name || '');
    setError('');
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setDraftName(account.name || '');
    setError('');
    setIsEditing(false);
  };

  const handleSaveName = async (event) => {
    event.preventDefault();
    const nextName = draftName.trim();

    if (!nextName) {
      setError('Account name is required.');
      return;
    }

    if (nextName === account.name) {
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    setError('');

    try {
      await updateAccount(account.id, { name: nextName });
      setIsEditing(false);
    } catch (saveError) {
      setError(saveError?.message || 'Could not update account name.');
    } finally {
      setIsSaving(false);
    }
  };

  const isNegative = account.currentBalance < 0;

  return (
    <div className="account-card glass-card">
      <div className="account-header">
        <div className="account-icon-wrapper">
          {getAccountIcon(account.type)}
        </div>
        <div className="account-actions">
          <button className="icon-btn" onClick={handleStartEdit} title="Edit account name" disabled={isEditing}>
            <Edit3 size={16} />
          </button>
        </div>
      </div>
      
      <div className="account-info">
        {isEditing ? (
          <form className="account-edit-form" onSubmit={handleSaveName}>
            <label className="sr-only" htmlFor={`account-name-${account.id}`}>Account name</label>
            <input
              id={`account-name-${account.id}`}
              className="input account-name-input"
              value={draftName}
              onChange={(event) => {
                setDraftName(event.target.value);
                if (error) setError('');
              }}
              autoFocus
              disabled={isSaving}
            />
            <div className="account-edit-actions">
              <button className="icon-btn save-btn" type="submit" title="Save account name" disabled={isSaving}>
                <Check size={16} />
              </button>
              <button className="icon-btn" type="button" onClick={handleCancelEdit} title="Cancel edit" disabled={isSaving}>
                <X size={16} />
              </button>
            </div>
            {error && <div className="account-edit-error">{error}</div>}
          </form>
        ) : (
          <h3 className="account-name">{account.name}</h3>
        )}
        <p className="account-institution">{account.institution || 'No Institution'}</p>
        <span className="account-type-badge">{getAccountTypeLabel(account.type)}</span>
      </div>

      <div className="account-balance">
        <div className="balance-label">Current Balance</div>
        <div className={`balance-value ${isNegative ? 'negative' : 'positive'}`}>
          {new Intl.NumberFormat('en-US', { style: 'currency', currency: account.currency || 'USD' }).format(account.currentBalance || 0)}
        </div>
      </div>
    </div>
  );
}
