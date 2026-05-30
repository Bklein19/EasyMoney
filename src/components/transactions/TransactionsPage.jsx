import { useMemo, useState } from 'react';
import { useTransactions } from '../../hooks/useTransactions';
import TransactionRow from './TransactionRow';
import TransactionFilters from './TransactionFilters';
import { formatCurrency, getAmountClass } from '../../utils/formatters';
import { useAccounts } from '../../hooks/useAccounts';
import { useCategories } from '../../hooks/useCategories';
import { buildAccountMap, getTransactionFlow, isCreditAccount, isExcludedFromCashFlow, isExpense, isIncome, isInvestmentMovement } from '../../utils/transactionSemantics';
import './TransactionsPage.css';

export default function TransactionsPage() {
  const [filters, setFilters] = useState({});
  const [isCreatingBulkCategory, setIsCreatingBulkCategory] = useState(false);
  const [newBulkCategoryName, setNewBulkCategoryName] = useState('');
  const [pendingBulkCategoryValue, setPendingBulkCategoryValue] = useState(null);
  const { transactions, updateTransaction, deleteTransaction } = useTransactions(filters);
  const { accounts, updateBalance } = useAccounts();
  const { categories, addCategory } = useCategories();
  const accountMap = useMemo(() => buildAccountMap(accounts), [accounts]);
  const categoryMap = useMemo(() => {
    const map = {};
    categories.forEach(c => { map[c.id] = c; });
    return map;
  }, [categories]);
  const visibleTransactions = useMemo(() => {
    const filtered = transactions.filter(tx => {
      const account = accountMap[tx.accountId];
      if (filters.accountKind === 'bank' && isCreditAccount(account)) return false;
      if (filters.accountKind === 'credit' && !isCreditAccount(account)) return false;
      if (filters.flowType && getTransactionFlow(tx, accountMap, categoryMap) !== filters.flowType) return false;
      return true;
    });

    return [...filtered].sort((a, b) => {
      switch (filters.sortBy || 'date_desc') {
        case 'date_asc':
          return a.date.localeCompare(b.date);
        case 'amount_desc':
          return b.amount - a.amount;
        case 'amount_asc':
          return a.amount - b.amount;
        case 'absolute_desc':
          return Math.abs(b.amount) - Math.abs(a.amount);
        case 'absolute_asc':
          return Math.abs(a.amount) - Math.abs(b.amount);
        case 'date_desc':
        default:
          return b.date.localeCompare(a.date);
      }
    });
  }, [transactions, filters.accountKind, filters.flowType, filters.sortBy, accountMap, categoryMap]);

  const filteredCategoryValue = useMemo(() => {
    if (visibleTransactions.length === 0) return '';
    const firstCategory = visibleTransactions[0].categoryId || '';
    const hasMixedCategories = visibleTransactions.some(tx => (tx.categoryId || '') !== firstCategory);
    return hasMixedCategories ? '__mixed__' : String(firstCategory);
  }, [visibleTransactions]);

  const bulkCategorySelectValue = pendingBulkCategoryValue ?? filteredCategoryValue;

  const confirmLargeBulkChange = (count, categoryName) => {
    if (count <= 50) return true;
    return window.confirm(
      `This will set the category for ${count} visible transactions to "${categoryName}". This is a bulk edit and cannot be automatically undone.\n\nContinue?`
    );
  };

  const handleBulkCategoryChange = async (categoryId) => {
    const nextCategoryId = categoryId ? Number(categoryId) : null;
    await Promise.all(
      visibleTransactions.map(tx => updateTransaction(tx.id, { categoryId: nextCategoryId }))
    );
  };

  const handleApplyBulkCategory = async (categoryValue = bulkCategorySelectValue) => {
    if (categoryValue === '__mixed__' || visibleTransactions.length === 0) return;

    const categoryName = categoryValue
      ? categories.find(category => String(category.id) === String(categoryValue))?.name || 'selected category'
      : 'Uncategorized';

    if (!confirmLargeBulkChange(visibleTransactions.length, categoryName)) return;
    await handleBulkCategoryChange(categoryValue);
    setPendingBulkCategoryValue(null);
  };

  const inferBulkCategoryType = () => {
    const normalizedName = newBulkCategoryName.trim().toLowerCase();
    if (normalizedName === 'investment' || normalizedName === 'investments') return 'investment';
    if (filters.flowType === 'income') return 'income';
    if (filters.flowType === 'investment') return 'investment';
    if (filters.flowType === 'internal_transfer') return 'internal_transfer';
    if (filters.flowType === 'transfer' || filters.flowType === 'card_payment') return 'transfer';
    return 'expense';
  };

  const resetBulkCategoryCreate = () => {
    setIsCreatingBulkCategory(false);
    setNewBulkCategoryName('');
  };

  const handleCreateBulkCategory = async (event) => {
    event.preventDefault();

    const name = newBulkCategoryName.trim();
    if (!name) return;

    if (!confirmLargeBulkChange(visibleTransactions.length, name)) return;

    const existing = categories.find(category => category.name.toLowerCase() === name.toLowerCase());
    const categoryId = existing?.id || await addCategory({
      name,
      type: inferBulkCategoryType(),
      color: '#94a3b8',
      icon: 'tag'
    });

    await handleBulkCategoryChange(categoryId);
    setPendingBulkCategoryValue(null);
    resetBulkCategoryCreate();
  };

  const handleFilterChange = (nextFilters) => {
    setPendingBulkCategoryValue(null);
    setFilters(nextFilters);
  };

  const handleDeleteTransaction = async (transaction) => {
    const account = accountMap[transaction.accountId];
    await deleteTransaction(transaction.id);

    if (account) {
      await updateBalance(account.id, (account.currentBalance || 0) - transaction.amount);
    }
  };

  const totals = useMemo(() => {
    return visibleTransactions.reduce((summary, tx) => {
      if (isIncome(tx, accountMap, categoryMap)) summary.income += tx.amount;
      if (isExpense(tx, accountMap, categoryMap)) summary.expenses += Math.abs(tx.amount);
      if (isInvestmentMovement(tx, accountMap, categoryMap)) summary.investments += Math.abs(tx.amount);
      else if (isExcludedFromCashFlow(tx, accountMap, categoryMap)) summary.internalMovement += Math.abs(tx.amount);
      summary.net = summary.income - summary.expenses;
      return summary;
    }, { income: 0, expenses: 0, internalMovement: 0, investments: 0, net: 0 });
  }, [visibleTransactions, accountMap, categoryMap]);

  return (
    <div className="page">
      <div className="page__header stagger-in">
        <div>
          <h1 className="page__title">Transactions</h1>
          <p className="page__subtitle">View and categorize your transactions.</p>
        </div>
      </div>

      <div className="stagger-in">
        <TransactionFilters filters={filters} setFilters={handleFilterChange} />

        <div className="transactions-container">
          <div className="transactions-header">
            <h3 className="dashboard-card-title">All Transactions ({visibleTransactions.length})</h3>
            <div className="bulk-category-action transactions-bulk-actions">
              <div>
                <label htmlFor="bulkTransactionCategory">Bulk category edit</label>
                <p>Applies to all {visibleTransactions.length} visible transactions after filters.</p>
              </div>
              <select
                id="bulkTransactionCategory"
                className="filter-input"
                value={bulkCategorySelectValue}
                disabled={visibleTransactions.length === 0}
                onChange={(event) => {
                  if (event.target.value === '__add_custom__') {
                    setIsCreatingBulkCategory(true);
                    return;
                  }
                  resetBulkCategoryCreate();
                  setPendingBulkCategoryValue(event.target.value);
                }}
              >
                {filteredCategoryValue === '__mixed__' && <option value="__mixed__">Mixed categories</option>}
                <option value="">Uncategorized</option>
                {categories.map(category => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
                <option value="__add_custom__">+ Add custom category</option>
              </select>
              <button
                className="btn btn--secondary btn--sm bulk-category-action__apply"
                type="button"
                disabled={
                  visibleTransactions.length === 0 ||
                  bulkCategorySelectValue === '__mixed__' ||
                  bulkCategorySelectValue === filteredCategoryValue
                }
                onClick={() => handleApplyBulkCategory()}
              >
                Apply to {visibleTransactions.length}
              </button>
              {isCreatingBulkCategory && (
                <form className="inline-create" onSubmit={handleCreateBulkCategory}>
                  <input
                    className="input input--sm inline-create__input"
                    value={newBulkCategoryName}
                    onChange={(event) => setNewBulkCategoryName(event.target.value)}
                    placeholder="New category name"
                    autoFocus
                  />
                  <div className="inline-create__actions">
                    <button className="btn btn--primary btn--sm" type="submit" disabled={!newBulkCategoryName.trim()}>
                      Add
                    </button>
                    <button className="btn btn--ghost btn--sm" type="button" onClick={resetBulkCategoryCreate}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
            <div className="transactions-totals" aria-label="Filtered transaction totals">
              <div className="transactions-total">
                <span>Income</span>
                <strong className="amount amount--positive">{formatCurrency(totals.income)}</strong>
              </div>
              <div className="transactions-total">
                <span>Expenses</span>
                <strong className="amount amount--negative">{formatCurrency(totals.expenses)}</strong>
              </div>
              {totals.internalMovement > 0 && (
                <div className="transactions-total">
                  <span>Internal Movement</span>
                  <strong className="amount amount--neutral">{formatCurrency(totals.internalMovement)}</strong>
                </div>
              )}
              {totals.investments > 0 && (
                <div className="transactions-total">
                  <span>Investments</span>
                  <strong className="amount amount--neutral">{formatCurrency(totals.investments)}</strong>
                </div>
              )}
              <div className="transactions-total">
                <span>Net</span>
                <strong className={`amount ${getAmountClass(totals.net)}`}>{formatCurrency(totals.net, true)}</strong>
              </div>
            </div>
          </div>
          
          <div className="transactions-list">
            {visibleTransactions.length > 0 ? (
              visibleTransactions.map(tx => (
                <TransactionRow 
                  key={tx.id} 
                  transaction={tx} 
                  onUpdate={updateTransaction} 
                  onDelete={handleDeleteTransaction}
                  account={accountMap[tx.accountId]}
                  categories={categories}
                  addCategory={addCategory}
                />
              ))
            ) : (
              <div className="empty-state-simple" style={{ height: 200 }}>
                No transactions found for the selected filters.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
