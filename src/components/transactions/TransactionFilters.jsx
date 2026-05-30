import { useCategories } from '../../hooks/useCategories';
import { useAccounts } from '../../hooks/useAccounts';

export default function TransactionFilters({ filters, setFilters }) {
  const { categories } = useCategories();
  const { accounts } = useAccounts();

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFilters(prev => ({
      ...prev,
      [name]: value === '' ? undefined : value
    }));
  };

  return (
    <div className="filters-container">
      <input
        type="text"
        name="searchQuery"
        placeholder="Search transactions..."
        className="filter-input"
        value={filters.searchQuery || ''}
        onChange={handleChange}
      />
      
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
        name="categoryId" 
        className="filter-input"
        value={filters.categoryId || ''}
        onChange={handleChange}
      >
        <option value="">All Categories</option>
        {categories.map(c => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      <select 
        name="sortBy"
        className="filter-input"
        value={filters.sortBy || 'date_desc'}
        onChange={handleChange}
      >
        <option value="date_desc">Newest first</option>
        <option value="date_asc">Oldest first</option>
        <option value="amount_desc">Highest amount</option>
        <option value="amount_asc">Lowest amount</option>
        <option value="absolute_desc">Largest dollar amount</option>
        <option value="absolute_asc">Smallest dollar amount</option>
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
  );
}
