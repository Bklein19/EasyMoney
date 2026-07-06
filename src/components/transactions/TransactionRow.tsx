import CategoryPicker from './CategoryPicker';
import { formatDate, formatCurrency, getAmountClass } from '../../utils/formatters';
import type { CategorySummary } from '../../../server/app/types';

interface TransactionRowItem {
  id: number | string;
  categoryId: number | string | null;
  date: string;
  amount: number;
  merchant?: string | null;
  description?: string | null;
  notes?: string | null;
  accountName?: string | null;
}

interface TransactionRowProps {
  transaction: TransactionRowItem;
  onUpdate: (id: number | string, changes: { categoryId: number | string | null }) => void;
  categories: CategorySummary[];
  addCategory: (category: Record<string, unknown>) => Promise<number | string>;
}

export default function TransactionRow({ transaction, onUpdate, categories, addCategory }: TransactionRowProps) {
  const handleCategoryChange = (categoryId: number | string | null) => {
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
