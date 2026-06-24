import type { ChangeEvent, Dispatch, SetStateAction } from 'react';
import { useCategories } from '../../hooks/useCategories';
import { useAccounts } from '../../hooks/useAccounts';

interface TransactionFilterState {
  searchQuery?: string;
  accountId?: string;
  categoryId?: string;
  accountKind?: string;
  flowType?: string;
  startDate?: string;
  endDate?: string;
  sortBy?: string;
}

interface TransactionFiltersProps {
  filters: TransactionFilterState;
  setFilters: Dispatch<SetStateAction<TransactionFilterState>>;
}

export default function TransactionFilters({ filters, setFilters }: TransactionFiltersProps) {
  const { categories } = useCategories();
  const { accounts } = useAccounts();
  const advancedFilterCount = [
    filters.accountKind,
    filters.flowType,
    filters.startDate,
    filters.endDate,
    filters.sortBy && filters.sortBy !== 'date_desc' ? filters.sortBy : undefined,
  ].filter(Boolean).length;

  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFilters(prev => ({
      ...prev,
      [name]: value === '' ? undefined : value
    }));
  };

  return (
    <div className="filters-container">
      <div className="transaction-search-control">
        <input
          type="search"
          name="searchQuery"
          placeholder="Search transactions..."
          className="filter-input"
          value={filters.searchQuery || ''}
          onChange={handleChange}
          autoComplete="off"
          enterKeyHint="search"
        />
      </div>

      <select 
        name="accountId" 
        className="filter-input"
        value={filters.accountId || ''}
        onChange={handleChange}
      >
        <option value="">All Accounts</option>
        {accounts.map(a => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>

      <select 
        name="categoryId" 
        className="filter-input"
        value={filters.categoryId || ''}
        onChange={handleChange}
      >
        <option value="">All Categories</option>
        <option value="uncategorized">Uncategorized</option>
        {categories
          .filter(c => c.name.toLowerCase() !== 'uncategorized')
          .map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
      </select>

      <details className="transaction-filter-more">
        <summary>
          More filters{advancedFilterCount > 0 ? ` (${advancedFilterCount})` : ''}
        </summary>
        <div className="transaction-filter-more__panel">
          <select
            name="accountKind"
            className="filter-input"
            value={filters.accountKind || ''}
            onChange={handleChange}
          >
            <option value="">All Account Kinds</option>
            <option value="bank">Bank / Cash Accounts</option>
            <option value="credit">Credit Cards</option>
          </select>

          <select
            name="flowType"
            className="filter-input"
            value={filters.flowType || ''}
            onChange={handleChange}
          >
            <option value="">All Activity</option>
            <option value="expense">Spending</option>
            <option value="income">Income</option>
            <option value="investment">Investments</option>
            <option value="card_payment">Card Payments</option>
            <option value="internal_transfer">Internal Transfers</option>
            <option value="transfer">Transfers</option>
          </select>

          <select
            name="sortBy"
            className="filter-input"
            value={filters.sortBy || 'date_desc'}
            onChange={handleChange}
          >
            <option value="date_desc">Newest first</option>
            <option value="date_asc">Oldest first</option>
            <option value="description_asc">Description A-Z</option>
            <option value="description_desc">Description Z-A</option>
            <option value="category_asc">Category A-Z</option>
            <option value="category_desc">Category Z-A</option>
            <option value="account_asc">Account A-Z</option>
            <option value="account_desc">Account Z-A</option>
            <option value="amount_desc">Highest amount</option>
            <option value="amount_asc">Lowest amount</option>
            <option value="absolute_desc">Largest dollar amount</option>
            <option value="absolute_asc">Smallest dollar amount</option>
          </select>

          <input
            type="date"
            name="startDate"
            className="filter-input"
            value={filters.startDate || ''}
            onChange={handleChange}
          />
          <input
            type="date"
            name="endDate"
            className="filter-input"
            value={filters.endDate || ''}
            onChange={handleChange}
          />
        </div>
      </details>
    </div>
  );
}
