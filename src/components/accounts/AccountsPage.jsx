import { useAccounts } from '../../hooks/useAccounts';
import AccountCard from './AccountCard';
import './AccountsPage.css';

export default function AccountsPage() {
  const { accounts } = useAccounts({ includeArchived: true });

  const activeAccounts = accounts.filter(account => account.status !== 'archived');
  const totalBalance = activeAccounts.reduce((sum, acc) => sum + (acc.currentBalance || 0), 0);

  return (
    <div className="page accounts-page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Accounts</h1>
          <p className="page__subtitle">Manage imported financial accounts and view active balances</p>
        </div>
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
            <p>No accounts yet. Import a file to create or match an account.</p>
          </div>
        ) : (
          accounts.map(account => (
            <AccountCard key={account.id} account={account} />
          ))
        )}
      </div>
    </div>
  );
}
