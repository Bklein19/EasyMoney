import { useState, useMemo } from 'react';
import { startOfMonth, endOfMonth, subMonths, startOfYear, endOfYear, subDays, format, parseISO, endOfDay } from 'date-fns';
import { Calendar, Landmark, Search, X } from 'lucide-react';
import { useTransactions } from '../../hooks/useTransactions';
import { useCategories } from '../../hooks/useCategories';
import { useAccounts } from '../../hooks/useAccounts';
import { formatCurrency, formatDate, getAmountClass } from '../../utils/formatters';
import { buildAccountMap, isCreditAccount, isExcludedFromCashFlow, isExpense, isIncome, isInvestmentMovement } from '../../utils/transactionSemantics';

import SpendingByCategory from './SpendingByCategory';
import SpendingTrends from './SpendingTrends';
import IncomeVsExpense from './IncomeVsExpense';
import TopMerchants from './TopMerchants';
import IncomeStreams from './IncomeStreams';
import InvestmentTrends from './InvestmentTrends';

import './Analytics.css';

const DATE_RANGES = {
  LAST_30: 'Last 30 Days',
  THIS_MONTH: 'This Month',
  LAST_MONTH: 'Last Month',
  THIS_YEAR: 'This Year',
  CUSTOM: 'Custom',
  ALL_TIME: 'All Time'
};

const CASH_FLOW_GROUPS = {
  AUTO: 'Auto',
  MONTH: 'Monthly',
  YEAR: 'Yearly'
};

const ANALYSIS_SCOPES = {
  CASH_FLOW: 'Cash Flow',
  BANK: 'Bank Accounts Only',
  CREDIT: 'Credit Cards Only',
  ALL_ACTIVITY: 'All Activity'
};

export default function AnalyticsPage() {
  const [dateRange, setDateRange] = useState(DATE_RANGES.THIS_MONTH);
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [accountId, setAccountId] = useState('');
  const [analysisScope, setAnalysisScope] = useState(ANALYSIS_SCOPES.CASH_FLOW);
  const [cashFlowGroup, setCashFlowGroup] = useState(CASH_FLOW_GROUPS.AUTO);
  const [drilldown, setDrilldown] = useState(null);
  const [drilldownSearch, setDrilldownSearch] = useState('');
  const [drilldownSort, setDrilldownSort] = useState('date_desc');
  const [isCreatingDrilldownCategory, setIsCreatingDrilldownCategory] = useState(false);
  const [newDrilldownCategoryName, setNewDrilldownCategoryName] = useState('');
  const [pendingDrilldownCategoryValue, setPendingDrilldownCategoryValue] = useState(null);
  
  const { startDate, endDate } = useMemo(() => {
    const today = new Date();
    switch (dateRange) {
      case DATE_RANGES.LAST_30:
        return { startDate: subDays(today, 30).toISOString(), endDate: today.toISOString() };
      case DATE_RANGES.THIS_MONTH:
        return { startDate: startOfMonth(today).toISOString(), endDate: endOfMonth(today).toISOString() };
      case DATE_RANGES.LAST_MONTH: {
        const lastMonth = subMonths(today, 1);
        return { startDate: startOfMonth(lastMonth).toISOString(), endDate: endOfMonth(lastMonth).toISOString() };
      }
      case DATE_RANGES.THIS_YEAR:
        return { startDate: startOfYear(today).toISOString(), endDate: endOfYear(today).toISOString() };
      case DATE_RANGES.CUSTOM:
        return {
          startDate: customStartDate ? parseISO(customStartDate).toISOString() : null,
          endDate: customEndDate ? endOfDay(parseISO(customEndDate)).toISOString() : null
        };
      case DATE_RANGES.ALL_TIME:
      default:
        return { startDate: null, endDate: null };
    }
  }, [dateRange, customStartDate, customEndDate]);

  const { transactions, updateTransaction } = useTransactions({ startDate, endDate, accountId });
  const { categories, addCategory } = useCategories();
  const { accounts } = useAccounts();
  const accountMap = useMemo(() => buildAccountMap(accounts), [accounts]);

  // Create a fast map for category lookup
  const categoryMap = useMemo(() => {
    const map = {};
    categories.forEach(c => { map[c.id] = c; });
    return map;
  }, [categories]);

  const scopedTransactions = useMemo(() => {
    return transactions.filter(transaction => {
      const account = accountMap[transaction.accountId];
      if (analysisScope === ANALYSIS_SCOPES.BANK) return !isCreditAccount(account);
      if (analysisScope === ANALYSIS_SCOPES.CREDIT) return isCreditAccount(account);
      return true;
    });
  }, [transactions, analysisScope, accountMap]);

  const analysisTransactions = useMemo(() => {
    if (analysisScope === ANALYSIS_SCOPES.ALL_ACTIVITY) return scopedTransactions;
    return scopedTransactions.filter(transaction => !isExcludedFromCashFlow(transaction, accountMap, categoryMap));
  }, [scopedTransactions, analysisScope, accountMap, categoryMap]);

  // Derived Summary
  const { totalIncome, totalExpense, filteredInternalMovement, filteredInvestments } = useMemo(() => {
    let inc = 0;
    let exp = 0;
    let internalMovement = 0;
    let investments = 0;
    scopedTransactions.forEach(t => {
      if (isInvestmentMovement(t, accountMap, categoryMap)) {
        investments += Math.abs(t.amount);
      } else if (isExcludedFromCashFlow(t, accountMap, categoryMap)) {
        internalMovement += Math.abs(t.amount);
      }
    });
    analysisTransactions.forEach(t => {
      if (isIncome(t, accountMap, categoryMap)) inc += t.amount;
      else if (isExpense(t, accountMap, categoryMap)) exp += Math.abs(t.amount);
    });
    return { totalIncome: inc, totalExpense: exp, filteredInternalMovement: internalMovement, filteredInvestments: investments };
  }, [scopedTransactions, analysisTransactions, accountMap, categoryMap]);

  const cashFlowRows = useMemo(() => {
    if (analysisTransactions.length === 0) return [];

    const dates = analysisTransactions.map(t => new Date(t.date).getTime());
    const diffDays = (Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24);
    const groupMode = cashFlowGroup === CASH_FLOW_GROUPS.AUTO
      ? (diffDays > 400 ? CASH_FLOW_GROUPS.YEAR : CASH_FLOW_GROUPS.MONTH)
      : cashFlowGroup;
    const keyFormat = groupMode === CASH_FLOW_GROUPS.YEAR ? 'yyyy' : 'yyyy-MM';
    const labelFormat = groupMode === CASH_FLOW_GROUPS.YEAR ? 'yyyy' : 'MMM yyyy';

    const grouped = {};
    analysisTransactions.forEach(t => {
      const dateObj = parseISO(t.date);
      const key = format(dateObj, keyFormat);
      if (!grouped[key]) {
        grouped[key] = { key, label: format(dateObj, labelFormat), income: 0, expenses: 0, net: 0, count: 0 };
      }
      if (isIncome(t, accountMap, categoryMap)) grouped[key].income += t.amount;
      if (isExpense(t, accountMap, categoryMap)) grouped[key].expenses += Math.abs(t.amount);
      grouped[key].net = grouped[key].income - grouped[key].expenses;
      grouped[key].count += 1;
    });

    return Object.values(grouped).sort((a, b) => b.key.localeCompare(a.key));
  }, [analysisTransactions, cashFlowGroup, accountMap, categoryMap]);

  const drilldownTransactions = useMemo(() => {
    if (!drilldown) return [];

    const sourceTransactions = drilldown.type === 'investmentPeriod' ? scopedTransactions : analysisTransactions;

    return sourceTransactions.filter(t => {
      if (drilldown.type === 'category') {
        const catId = t.categoryId || 'uncategorized';
        return String(catId) === String(drilldown.id) && isExpense(t, accountMap, categoryMap);
      }
      if (drilldown.type === 'merchant') {
        return drilldown.ids?.has(t.id) && isExpense(t, accountMap, categoryMap);
      }
      if (drilldown.type === 'incomeStream') {
        return drilldown.ids?.has(t.id) && isIncome(t, accountMap, categoryMap);
      }
      if (drilldown.type === 'period') {
        return drilldown.ids.has(t.id);
      }
      if (drilldown.type === 'investmentPeriod') {
        return drilldown.ids.has(t.id) && isInvestmentMovement(t, accountMap, categoryMap);
      }
      return false;
    });
  }, [analysisTransactions, scopedTransactions, drilldown, accountMap, categoryMap]);

  const visibleDrilldownTransactions = useMemo(() => {
    const query = drilldownSearch.trim().toLowerCase();
    const searched = query
      ? drilldownTransactions.filter(transaction => {
        const categoryName = categoryMap[transaction.categoryId]?.name || 'Uncategorized';
        return [
          transaction.merchant,
          transaction.description,
          transaction.notes,
          categoryName,
          String(transaction.amount)
        ].filter(Boolean).some(value => String(value).toLowerCase().includes(query));
      })
      : drilldownTransactions;

    return [...searched].sort((a, b) => {
      switch (drilldownSort) {
        case 'amount_desc':
          return Math.abs(b.amount) - Math.abs(a.amount);
        case 'amount_asc':
          return Math.abs(a.amount) - Math.abs(b.amount);
        case 'date_asc':
          return a.date.localeCompare(b.date);
        case 'date_desc':
        default:
          return b.date.localeCompare(a.date);
      }
    });
  }, [drilldownTransactions, drilldownSearch, drilldownSort, categoryMap]);

  const drilldownCategoryValue = useMemo(() => {
    if (visibleDrilldownTransactions.length === 0) return '';
    const firstCategory = visibleDrilldownTransactions[0].categoryId || '';
    const hasMixedCategories = visibleDrilldownTransactions.some(transaction => (transaction.categoryId || '') !== firstCategory);
    return hasMixedCategories ? '__mixed__' : String(firstCategory);
  }, [visibleDrilldownTransactions]);

  const drilldownCategorySelectValue = pendingDrilldownCategoryValue ?? drilldownCategoryValue;

  const confirmLargeDrilldownChange = (count, categoryName) => {
    if (count <= 50) return true;
    return window.confirm(
      `This will set the category for ${count} visible drilldown transactions to "${categoryName}". This is a bulk edit and cannot be automatically undone.\n\nContinue?`
    );
  };

  const handleBulkCategoryChange = async (categoryId) => {
    const nextCategoryId = categoryId ? Number(categoryId) : null;
    await Promise.all(
      visibleDrilldownTransactions.map(transaction => updateTransaction(transaction.id, { categoryId: nextCategoryId }))
    );
  };

  const handleApplyDrilldownCategory = async (categoryValue = drilldownCategorySelectValue) => {
    if (categoryValue === '__mixed__' || visibleDrilldownTransactions.length === 0) return;

    const categoryName = categoryValue
      ? categories.find(category => String(category.id) === String(categoryValue))?.name || 'selected category'
      : 'Uncategorized';

    if (!confirmLargeDrilldownChange(visibleDrilldownTransactions.length, categoryName)) return;
    await handleBulkCategoryChange(categoryValue);
    setPendingDrilldownCategoryValue(null);
  };

  const inferDrilldownCategoryType = () => {
    const normalizedName = newDrilldownCategoryName.trim().toLowerCase();
    if (normalizedName === 'investment' || normalizedName === 'investments') return 'investment';
    if (drilldown?.type === 'incomeStream') return 'income';
    return 'expense';
  };

  const resetDrilldownCategoryCreate = () => {
    setIsCreatingDrilldownCategory(false);
    setNewDrilldownCategoryName('');
  };

  const handleCreateDrilldownCategory = async (event) => {
    event.preventDefault();

    const name = newDrilldownCategoryName.trim();
    if (!name) return;

    if (!confirmLargeDrilldownChange(visibleDrilldownTransactions.length, name)) return;

    const existing = categories.find(category => category.name.toLowerCase() === name.toLowerCase());
    const categoryId = existing?.id || await addCategory({
      name,
      type: inferDrilldownCategoryType(),
      color: '#94a3b8',
      icon: 'tag'
    });

    await handleBulkCategoryChange(categoryId);
    setPendingDrilldownCategoryValue(null);
    resetDrilldownCategoryCreate();
  };

  const openDrilldown = (nextDrilldown) => {
    setDrilldownSearch('');
    setDrilldownSort('date_desc');
    setPendingDrilldownCategoryValue(null);
    setDrilldown(nextDrilldown);
  };

  const handlePeriodSelect = (period) => {
    if (period.startDate && period.endDate) {
      setCustomStartDate(period.startDate);
      setCustomEndDate(period.endDate);
      setDateRange(DATE_RANGES.CUSTOM);
    }
    setDrilldown(null);
    setDrilldownSearch('');
    setDrilldownSort('date_desc');
  };

  const handleInvestmentPeriodSelect = (period) => {
    openDrilldown({
      type: 'investmentPeriod',
      title: `${period.displayLabel} Investments`,
      ids: new Set(period.transactionIds)
    });
  };

  return (
    <div className="page analytics-page stagger-in">
      <div className="page__header">
        <div>
          <h1 className="page__title">Analytics</h1>
          <p className="page__subtitle">Insights into your financial habits</p>
        </div>
        
        <div className="analytics-controls">
          <div className="date-range-selector">
            <Landmark size={18} className="text-muted" />
            <select
              className="input input--sm"
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                setPendingDrilldownCategoryValue(null);
                setDrilldown(null);
              }}
            >
              <option value="">All Accounts</option>
              {accounts.map(account => (
                <option key={account.id} value={account.id}>{account.name}</option>
              ))}
            </select>
          </div>

          <div className="date-range-selector">
            <select
              className="input input--sm"
              value={analysisScope}
              onChange={(e) => {
                setAnalysisScope(e.target.value);
                setPendingDrilldownCategoryValue(null);
                setDrilldown(null);
              }}
            >
              {Object.values(ANALYSIS_SCOPES).map(scope => (
                <option key={scope} value={scope}>{scope}</option>
              ))}
            </select>
          </div>

          <div className="date-range-selector">
            <Calendar size={18} className="text-muted" />
            <select 
              className="input input--sm"
              value={dateRange}
              onChange={(e) => {
                setDateRange(e.target.value);
                setPendingDrilldownCategoryValue(null);
                setDrilldown(null);
              }}
            >
              {Object.values(DATE_RANGES).map(range => (
                <option key={range} value={range}>{range}</option>
              ))}
            </select>
          </div>

          {dateRange === DATE_RANGES.CUSTOM && (
            <div className="date-range-selector date-range-selector--custom">
              <input
                className="input input--sm"
                type="date"
                value={customStartDate}
                onChange={(event) => {
                  setCustomStartDate(event.target.value);
                  setPendingDrilldownCategoryValue(null);
                  setDrilldown(null);
                }}
              />
              <span>to</span>
              <input
                className="input input--sm"
                type="date"
                value={customEndDate}
                onChange={(event) => {
                  setCustomEndDate(event.target.value);
                  setPendingDrilldownCategoryValue(null);
                  setDrilldown(null);
                }}
              />
            </div>
          )}

          <div className="date-range-selector">
            <select
              className="input input--sm"
              value={cashFlowGroup}
              onChange={(e) => setCashFlowGroup(e.target.value)}
            >
              {Object.values(CASH_FLOW_GROUPS).map(group => (
                <option key={group} value={group}>{group}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {analysisScope !== ANALYSIS_SCOPES.ALL_ACTIVITY && (filteredInternalMovement > 0 || filteredInvestments > 0) && (
        <div className="analytics-scope-note">
          {filteredInternalMovement > 0 && (
            <span>Internal movement totaling {formatCurrency(filteredInternalMovement)} is filtered from spending, including card payments and transfers between your own accounts.</span>
          )}
          {filteredInvestments > 0 && (
            <span> Investments totaling {formatCurrency(filteredInvestments)} are tracked separately and excluded from spending and net flow.</span>
          )}
        </div>
      )}

      <div className="analytics-summary grid-3">
        <div className="glass-card kpi-card">
          <div className="kpi-card__label">Total Income</div>
          <div className="kpi-card__value amount amount--positive">{formatCurrency(totalIncome)}</div>
        </div>
        <div className="glass-card kpi-card">
          <div className="kpi-card__label">Total Expense</div>
          <div className="kpi-card__value amount amount--negative">{formatCurrency(totalExpense)}</div>
        </div>
        <div className="glass-card kpi-card">
          <div className="kpi-card__label">Net Flow</div>
          <div className={`kpi-card__value amount ${totalIncome - totalExpense >= 0 ? 'amount--positive' : 'amount--negative'}`}>
            {formatCurrency(totalIncome - totalExpense)}
          </div>
        </div>
      </div>

      <div className="analytics-grid">
        <div className="analytics-card glass-card">
          <h3 className="analytics-card__title">Income vs Expense</h3>
          <IncomeVsExpense
            transactions={analysisTransactions}
            groupMode={cashFlowGroup}
            accountMap={accountMap}
            categoryMap={categoryMap}
            onSelectPeriod={handlePeriodSelect}
          />
        </div>
        
        <div className="analytics-card glass-card">
          <h3 className="analytics-card__title">Spending Trends</h3>
          <SpendingTrends
            transactions={analysisTransactions}
            categoryMap={categoryMap}
            accountMap={accountMap}
            groupMode={cashFlowGroup}
            onSelectPeriod={handlePeriodSelect}
          />
        </div>

        <div className="analytics-card glass-card">
          <h3 className="analytics-card__title">Spending by Category</h3>
          <SpendingByCategory
            transactions={analysisTransactions}
            categoryMap={categoryMap}
            accountMap={accountMap}
            onSelectCategory={(category) => openDrilldown({
              type: 'category',
              id: category.id,
              title: `${category.name} Transactions`
            })}
          />
        </div>
        
        <div className="analytics-card glass-card">
          <h3 className="analytics-card__title">Top Merchants</h3>
          <TopMerchants
            transactions={analysisTransactions}
            accountMap={accountMap}
            categoryMap={categoryMap}
            onSelectMerchant={(merchant) => openDrilldown({
              type: 'merchant',
              id: merchant.normalized,
              ids: new Set(merchant.transactionIds),
              title: `${merchant.name} Transactions`,
              aliases: merchant.aliases
            })}
          />
        </div>

        <div className="analytics-card glass-card">
          <h3 className="analytics-card__title">Income Streams</h3>
          <IncomeStreams
            transactions={analysisTransactions}
            accountMap={accountMap}
            categoryMap={categoryMap}
            onSelectStream={(stream) => openDrilldown({
              type: 'incomeStream',
              id: stream.normalized,
              ids: new Set(stream.transactionIds),
              title: `${stream.name} Income`,
              aliases: stream.aliases
            })}
          />
        </div>

        <div className="analytics-card glass-card">
          <h3 className="analytics-card__title">Investments Over Time</h3>
          <InvestmentTrends
            transactions={scopedTransactions}
            accountMap={accountMap}
            categoryMap={categoryMap}
            groupMode={cashFlowGroup}
            onSelectPeriod={handleInvestmentPeriodSelect}
          />
        </div>
      </div>

      <div className="analytics-card glass-card analytics-card--table">
        <h3 className="analytics-card__title">Cash Flow Summary</h3>
        <div className="cash-flow-table">
          {cashFlowRows.length > 0 ? cashFlowRows.map(row => (
            <button
              key={row.key}
              className="cash-flow-row"
              onClick={() => openDrilldown({
                type: 'period',
                title: `${row.label} Cash Flow`,
                ids: new Set(analysisTransactions.filter(t => {
                  const dateObj = parseISO(t.date);
                  const key = row.key.length === 4 ? format(dateObj, 'yyyy') : format(dateObj, 'yyyy-MM');
                  return key === row.key;
                }).map(t => t.id))
              })}
            >
              <span>{row.label}</span>
              <span className="amount amount--positive">{formatCurrency(row.income)}</span>
              <span className="amount amount--negative">{formatCurrency(row.expenses)}</span>
              <span className={`amount ${getAmountClass(row.net)}`}>{formatCurrency(row.net, true)}</span>
              <span>{row.count} tx</span>
            </button>
          )) : (
            <div className="empty-state-simple">No cash flow data for this period.</div>
          )}
        </div>
      </div>

      {drilldown && (
        <div className="analytics-card glass-card analytics-drilldown">
          <div className="analytics-drilldown__header">
            <div>
              <h3 className="analytics-card__title">{drilldown.title}</h3>
              <p>
                {visibleDrilldownTransactions.length} shown
                {visibleDrilldownTransactions.length !== drilldownTransactions.length && ` of ${drilldownTransactions.length}`}
                {' '}matching transaction{visibleDrilldownTransactions.length === 1 ? '' : 's'}
              </p>
              {drilldown.aliases?.length > 1 && (
                <div className="drilldown-aliases">
                  {drilldown.aliases.slice(0, 6).map(alias => (
                    <span key={alias}>{alias}</span>
                  ))}
                  {drilldown.aliases.length > 6 && <span>+{drilldown.aliases.length - 6} more</span>}
                </div>
              )}
            </div>
            <div className="bulk-category-action drilldown-actions">
              <div>
                <label htmlFor="bulkCategory">Bulk category edit</label>
                <p>Applies to all {visibleDrilldownTransactions.length} visible drilldown rows.</p>
              </div>
              <select
                id="bulkCategory"
                className="input input--sm"
                value={drilldownCategorySelectValue}
                disabled={visibleDrilldownTransactions.length === 0}
                onChange={(event) => {
                  if (event.target.value === '__add_custom__') {
                    setIsCreatingDrilldownCategory(true);
                    return;
                  }
                  resetDrilldownCategoryCreate();
                  setPendingDrilldownCategoryValue(event.target.value);
                }}
              >
                {drilldownCategoryValue === '__mixed__' && <option value="__mixed__">Mixed categories</option>}
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
                  visibleDrilldownTransactions.length === 0 ||
                  drilldownCategorySelectValue === '__mixed__' ||
                  drilldownCategorySelectValue === drilldownCategoryValue
                }
                onClick={() => handleApplyDrilldownCategory()}
              >
                Apply to {visibleDrilldownTransactions.length}
              </button>
              {isCreatingDrilldownCategory && (
                <form className="inline-create" onSubmit={handleCreateDrilldownCategory}>
                  <input
                    className="input input--sm inline-create__input"
                    value={newDrilldownCategoryName}
                    onChange={(event) => setNewDrilldownCategoryName(event.target.value)}
                    placeholder="New category name"
                    autoFocus
                  />
                  <div className="inline-create__actions">
                    <button className="btn btn--primary btn--sm" type="submit" disabled={!newDrilldownCategoryName.trim()}>
                      Add
                    </button>
                    <button className="btn btn--ghost btn--sm" type="button" onClick={resetDrilldownCategoryCreate}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
            <button className="btn btn--ghost btn--icon" onClick={() => setDrilldown(null)} aria-label="Close drilldown">
              <X size={18} />
            </button>
          </div>
          <div className="drilldown-toolbar">
            <label className="drilldown-search">
              <Search size={14} />
              <input
                className="input input--sm"
                value={drilldownSearch}
                onChange={(event) => setDrilldownSearch(event.target.value)}
                placeholder="Search matching transactions"
              />
            </label>
            <select
              className="input input--sm drilldown-sort"
              value={drilldownSort}
              onChange={(event) => setDrilldownSort(event.target.value)}
            >
              <option value="date_desc">Newest first</option>
              <option value="date_asc">Oldest first</option>
              <option value="amount_desc">Highest cost first</option>
              <option value="amount_asc">Lowest cost first</option>
            </select>
          </div>
          <div className="drilldown-list">
            {visibleDrilldownTransactions.slice(0, 25).map(transaction => (
              <div key={transaction.id} className="drilldown-row">
                <span>{formatDate(transaction.date, 'medium')}</span>
                <strong className="truncate">{transaction.merchant || transaction.description}</strong>
                <span>{categoryMap[transaction.categoryId]?.name || 'Uncategorized'}</span>
                <span className={`amount ${getAmountClass(transaction.amount)}`}>{formatCurrency(transaction.amount, true)}</span>
              </div>
            ))}
            {visibleDrilldownTransactions.length > 25 && (
              <div className="drilldown-footer">Showing first 25 transactions.</div>
            )}
            {visibleDrilldownTransactions.length === 0 && (
              <div className="drilldown-footer">No matching transactions for this filter.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
