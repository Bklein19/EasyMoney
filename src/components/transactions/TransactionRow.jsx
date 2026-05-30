import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import CategoryPicker from './CategoryPicker';
import { formatDate, formatCurrency, getAmountClass } from '../../utils/formatters';

export default function TransactionRow({ transaction, onUpdate, onDelete, account, categories, addCategory }) {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleCategoryChange = (categoryId) => {
    onUpdate(transaction.id, { categoryId });
  };

  const handleDelete = async () => {
    const label = transaction.merchant || transaction.description || 'this transaction';
    if (!window.confirm(`Delete "${label}" from your records? This cannot be undone.`)) return;

    setIsDeleting(true);
    try {
      await onDelete(transaction);
    } catch (error) {
      console.error('Delete transaction error:', error);
      alert('Unable to delete this transaction. Please try again.');
      setIsDeleting(false);
    }
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
        {account ? account.name : 'Unknown Account'}
      </div>
      <div className={`tx-amount ${getAmountClass(transaction.amount)}`}>
        {formatCurrency(transaction.amount, true)}
      </div>
      <button
        className="tx-delete-btn"
        type="button"
        aria-label={`Delete ${transaction.merchant || transaction.description || 'transaction'}`}
        title="Delete transaction"
        disabled={isDeleting}
        onClick={handleDelete}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
