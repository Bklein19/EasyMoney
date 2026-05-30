import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAccounts } from '../../hooks/useAccounts';
import AccountCard from './AccountCard';
import AddAccountModal from './AddAccountModal';
import './AccountsPage.css';

export default function AccountsPage() {
  const { accounts } = useAccounts();
  const [isModalOpen, setIsModalOpen] = useState(false);

  const totalBalance = accounts.reduce((sum, acc) => sum + (acc.currentBalance || 0), 0);

  return (
    <div className="page accounts-page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Accounts</h1>
          <p className="page__subtitle">Manage your financial accounts and view balances</p>
        </div>
        <button className="btn btn--primary" onClick={() => setIsModalOpen(true)}>
          <Plus size={20} />
          Add Account
        </button>
      </header>

      <div className="summary-cards">
        <div className="summary-card glass-card">
          <div className="summary-label">Total Net Balance</div>
          <div className="summary-value">
            {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(totalBalance)}
          </div>
        </div>
      </div>

      <div className="accounts-grid">
        {accounts.length === 0 ? (
          <div className="empty-state">
            <p>No accounts added yet.</p>
            <button className="btn btn--secondary mt-4" onClick={() => setIsModalOpen(true)}>
              Add your first account
            </button>
          </div>
        ) : (
          accounts.map(account => (
            <AccountCard key={account.id} account={account} />
          ))
        )}
      </div>

      {isModalOpen && (
        <AddAccountModal onClose={() => setIsModalOpen(false)} />
      )}
    </div>
  );
}
