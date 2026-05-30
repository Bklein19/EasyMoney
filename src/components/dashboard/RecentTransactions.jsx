import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { useTransactions } from '../../hooks/useTransactions';
import { useCategories } from '../../hooks/useCategories';
import { useAccounts } from '../../hooks/useAccounts';
import { formatDate, formatCurrency, getAmountClass } from '../../utils/formatters';

export default function RecentTransactions() {
  const { transactions } = useTransactions();
  const { categories } = useCategories();
  const { accounts } = useAccounts();

  const recent = transactions.slice(0, 5);

  const getCategoryName = (categoryId) => {
    const cat = categories.find(c => c.id === categoryId);
    return cat ? cat.name : 'Uncategorized';
  };

  const getAccountName = (accountId) => {
    const account = accounts.find(a => a.id === accountId);
    return account ? account.name : 'Unknown Account';
  };

  return (
    <div className="glass-card dashboard-recent">
      <div className="dashboard-card-header">
        <h3 className="dashboard-card-title">Recent Transactions</h3>
        <a href="/transactions" className="text-sm text-muted">View all</a>
      </div>
      <div className="dashboard-card-content" style={{ padding: 0 }}>
        {recent.length > 0 ? (
          <div className="flex-col">
            {recent.map((tx, index) => {
              const title = tx.merchant || tx.description || 'Untitled transaction';
              const subtitle = tx.merchant && tx.description && tx.merchant !== tx.description
                ? tx.description
                : getAccountName(tx.accountId);

              return (
              <div key={tx.id ?? `${tx.date}-${tx.amount}-${index}`} className="flex justify-between items-center" style={{ padding: 'var(--space-4) var(--space-5)', borderBottom: '1px solid var(--glass-border)' }}>
                <div className="flex items-center gap-4">
                  <div className="kpi-card__icon-wrapper" style={{ background: 'var(--bg-elevated)' }}>
                    {tx.amount > 0 ? (
                      <ArrowUpRight size={20} className="text-success" style={{ color: 'var(--color-success)' }} />
                    ) : (
                      <ArrowDownRight size={20} className="text-danger" style={{ color: 'var(--color-danger)' }} />
                    )}
                  </div>
                  <div className="truncate">
                    <div className="truncate" style={{ fontWeight: 500 }}>{title}</div>
                    <div className="text-xs text-secondary truncate">{subtitle}</div>
                    <div className="text-xs text-muted flex gap-2">
                      <span>{formatDate(tx.date)}</span>
                      <span>/</span>
                      <span>{getCategoryName(tx.categoryId)}</span>
                    </div>
                  </div>
                </div>
                <div className={getAmountClass(tx.amount)} style={{ fontWeight: 600 }}>
                  {formatCurrency(tx.amount, true)}
                </div>
              </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-state-simple" style={{ height: '200px' }}>No recent transactions</div>
        )}
      </div>
    </div>
  );
}
