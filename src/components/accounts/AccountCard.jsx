import { Building2, CreditCard, Landmark, PiggyBank, Trash2 } from 'lucide-react';
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
  const { deleteAccount } = useAccounts();

  const handleDelete = () => {
    if (window.confirm(`Are you sure you want to delete ${account.name}? This will also delete all associated transactions.`)) {
      deleteAccount(account.id);
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
          <button className="icon-btn delete-btn" onClick={handleDelete} title="Delete account">
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      
      <div className="account-info">
        <h3 className="account-name">{account.name}</h3>
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
