import CategoryPicker from './CategoryPicker';
import { formatDate, formatCurrency, getAmountClass } from '../../utils/formatters';

export default function TransactionRow({ transaction, onUpdate, categories, addCategory }) {
  const handleCategoryChange = (categoryId) => {
    onUpdate(transaction.id, { categoryId });
  };

  return (
    <div className="transaction-row">
      <div className="tx-date">{formatDate(transaction.date, 'medium')}</div>
      <div className="tx-desc">
        <span className="truncate">{transaction.merchant || transaction.description}</span>
        {transaction.merchant && transaction.merchant !== transaction.description && (
          <span className="tx-notes truncate">{transaction.description}</span>
        )}
        {transaction.notes && <span className="tx-notes truncate">{transaction.notes}</span>}
      </div>
      <div className="tx-category">
        <CategoryPicker 
          categoryId={transaction.categoryId} 
          onChange={handleCategoryChange} 
          categories={categories}
          addCategory={addCategory}
        />
      </div>
      <div className="tx-account truncate">
        {transaction.accountName || 'Unknown Account'}
      </div>
      <div className={`tx-amount ${getAmountClass(transaction.amount)}`}>
        {formatCurrency(transaction.amount, true)}
      </div>
    </div>
  );
}
