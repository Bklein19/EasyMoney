import { useMemo, useState } from 'react';
import { addMonths, endOfDay, endOfMonth, endOfWeek, endOfYear, format, parseISO, startOfMonth, startOfWeek, startOfYear, subMonths, subWeeks } from 'date-fns';
import { Calendar, ChevronLeft, ChevronRight, HelpCircle, Landmark, RotateCcw, Search, X } from 'lucide-react';
import { useTransactions } from '../../hooks/useTransactions';
import { useCategories } from '../../hooks/useCategories';
import { useAccounts } from '../../hooks/useAccounts';
import { formatCurrency, formatDate, getAmountClass } from '../../utils/formatters';
import { buildAccountMap, isExcludedFromCashFlow, isExpense, isIncome, isInvestmentMovement } from '../../utils/transactionSemantics';

import SpendingByCategory from './SpendingByCategory';
import SpendingTrends from './SpendingTrends';
import IncomeVsExpense from './IncomeVsExpense';
import TopMerchants from './TopMerchants';
import IncomeStreams from './IncomeStreams';
import InvestmentTrends from './InvestmentTrends';
import Tooltip from '../shared/Tooltip';

import './Analytics.css';

const DATE_RANGES = {
  THIS_MONTH: 'This Month',
  LAST_MONTH: 'Last Month',
  LAST_WEEK: 'Last Week',
  THIS_YEAR: 'This Year',
  CUSTOM: 'Custom',
  ALL_TIME: 'All Time'
};

const CASH_FLOW_GROUPS = {
  AUTO: 'Auto',
  DAY: 'Daily',
  WEEK: 'Weekly',
  MONTH: 'Monthly',
  YEAR: 'Yearly'
};

const toDateInput = (date) => format(date, 'yyyy-MM-dd');
const DRILLDOWN_PAGE_SIZE = 20;

function getMonthSpan(startDate, endDate) {
  const start = parseISO(startDate);
  const end = parseISO(endDate);
  return Math.max(1, ((end.getFullYear() - start.getFullYear()) * 12) + end.getMonth() - start.getMonth() + 1);
}

export default function AnalyticsPage() {
  const [dateRange, setDateRange] = useState(DATE_RANGES.THIS_MONTH);
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [accountId, setAccountId] = useState('');
  const [categoryFilterId, setCategoryFilterId] = useState('');
  const [cashFlowGroup, setCashFlowGroup] = useState(CASH_FLOW_GROUPS.AUTO);
  const [drilldown, setDrilldown] = useState(null);
  const [drilldownSearch, setDrilldownSearch] = useState('');
  const [drilldownSort, setDrilldownSort] = useState('date_desc');
  const [isCreatingDrilldownCategory, setIsCreatingDrilldownCategory] = useState(false);
  const [newDrilldownCategoryName, setNewDrilldownCategoryName] = useState('');
  const [pendingDrilldownCategoryValue, setPendingDrilldownCategoryValue] = useState(null);
  const [drilldownVisibleCount, setDrilldownVisibleCount] = useState(DRILLDOWN_PAGE_SIZE);
  
  const { startDate, endDate } = useMemo(() => {
    const today = new Date();
    switch (dateRange) {
      case DATE_RANGES.THIS_MONTH:
        return { startDate: startOfMonth(today).toISOString(), endDate: endOfMonth(today).toISOString() };
      case DATE_RANGES.LAST_MONTH: {
        const lastMonth = subMonths(today, 1);
        return { startDate: startOfMonth(lastMonth).toISOString(), endDate: endOfMonth(lastMonth).toISOString() };
      }
      case DATE_RANGES.LAST_WEEK: {
        const lastWeek = subWeeks(today, 1);
        return { startDate: startOfWeek(lastWeek).toISOString(), endDate: endOfWeek(lastWeek).toISOString() };
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

  const categoryScopedTransactions = useMemo(() => {
    if (!categoryFilterId) return transactions;
    return transactions.filter(transaction => {
      if (categoryFilterId === 'uncategorized') return !transaction.categoryId;
      return String(transaction.categoryId) === categoryFilterId;
    });
  }, [transactions, categoryFilterId]);

  const analysisTransactions = useMemo(() => {
    return categoryScopedTransactions.filter(transaction => !isExcludedFromCashFlow(transaction, accountMap, categoryMap));
  }, [categoryScopedTransactions, accountMap, categoryMap]);

  // Derived Summary
  const { totalIncome, totalExpense, filteredInternalMovement, filteredInvestments } = useMemo(() => {
    let inc = 0;
    let exp = 0;
    let internalMovement = 0;
    let investments = 0;
    categoryScopedTransactions.forEach(t => {
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
  }, [categoryScopedTransactions, analysisTransactions, accountMap, categoryMap]);

  const cashFlowRows = useMemo(() => {
    if (analysisTransactions.length === 0) return [];

    const dates = analysisTransactions.map(t => new Date(t.date).getTime());
    const diffDays = (Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24);
    const groupMode = cashFlowGroup === CASH_FLOW_GROUPS.AUTO
      ? (diffDays > 400 ? CASH_FLOW_GROUPS.YEAR : diffDays > 60 ? CASH_FLOW_GROUPS.MONTH : CASH_FLOW_GROUPS.WEEK)
      : cashFlowGroup;

    const grouped = {};
    analysisTransactions.forEach(t => {
      const dateObj = parseISO(t.date);
      const weekStart = startOfWeek(dateObj);
      const key = groupMode === CASH_FLOW_GROUPS.YEAR
        ? format(dateObj, 'yyyy')
        : groupMode === CASH_FLOW_GROUPS.MONTH
          ? format(dateObj, 'yyyy-MM')
          : groupMode === CASH_FLOW_GROUPS.WEEK
            ? format(weekStart, 'yyyy-MM-dd')
            : format(dateObj, 'yyyy-MM-dd');
      const label = groupMode === CASH_FLOW_GROUPS.YEAR
        ? format(dateObj, 'yyyy')
        : groupMode === CASH_FLOW_GROUPS.MONTH
          ? format(dateObj, 'MMM yyyy')
          : groupMode === CASH_FLOW_GROUPS.WEEK
            ? `Week of ${format(weekStart, 'MMM d')}`
            : format(dateObj, 'MMM d');
      if (!grouped[key]) {
        grouped[key] = { key, label, groupMode, income: 0, expenses: 0, net: 0, count: 0 };
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

    const sourceTransactions = drilldown.type === 'investmentPeriod' ? categoryScopedTransactions : analysisTransactions;

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
  }, [analysisTransactions, categoryScopedTransactions, drilldown, accountMap, categoryMap]);

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

  const loadedDrilldownTransactions = useMemo(() => {
    return visibleDrilldownTransactions.slice(0, drilldownVisibleCount);
  }, [visibleDrilldownTransactions, drilldownVisibleCount]);

  const hasMoreDrilldownTransactions = drilldownVisibleCount < visibleDrilldownTransactions.length;

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
    setDrilldownVisibleCount(DRILLDOWN_PAGE_SIZE);
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

  const resetAnalyticsSelection = () => {
    setPendingDrilldownCategoryValue(null);
    setDrilldown(null);
    setDrilldownSearch('');
    setDrilldownSort('date_desc');
    setDrilldownVisibleCount(DRILLDOWN_PAGE_SIZE);
  };

  const handleDrilldownScroll = (event) => {
    if (!hasMoreDrilldownTransactions) return;

    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 96) {
      setDrilldownVisibleCount(previous =>
        Math.min(previous + DRILLDOWN_PAGE_SIZE, visibleDrilldownTransactions.length)
      );
    }
  };

  const handleDateRangeChange = (nextRange) => {
    if (nextRange === DATE_RANGES.CUSTOM && !customStartDate && !customEndDate) {
      const today = new Date();
      setCustomStartDate(toDateInput(startOfMonth(today)));
      setCustomEndDate(toDateInput(endOfMonth(today)));
    }

    setDateRange(nextRange);
    resetAnalyticsSelection();
  };

  const handleCategoryFilterChange = (nextCategoryId) => {
    setCategoryFilterId(nextCategoryId);
    resetAnalyticsSelection();
  };

  const handleShiftMonthWindow = (direction) => {
    if (!startDate || !endDate) return;

    const spanMonths = getMonthSpan(startDate, endDate);
    const nextStart = startOfMonth(addMonths(parseISO(startDate), direction * spanMonths));
    const nextEnd = endOfMonth(addMonths(parseISO(endDate), direction * spanMonths));

    setCustomStartDate(toDateInput(nextStart));
    setCustomEndDate(toDateInput(nextEnd));
    setDateRange(DATE_RANGES.CUSTOM);
    resetAnalyticsSelection();
  };

  const handleResetToCurrentMonth = () => {
    setCustomStartDate('');
    setCustomEndDate('');
    setDateRange(DATE_RANGES.THIS_MONTH);
    resetAnalyticsSelection();
  };

  const activeDateLabel = useMemo(() => {
    if (!startDate || !endDate) return 'All available dates';
    return `${format(parseISO(startDate), 'MMM d, yyyy')} - ${format(parseISO(endDate), 'MMM d, yyyy')}`;
  }, [startDate, endDate]);

  const handleInvestmentPeriodSelect = (period) => {
    openDrilldown({
      type: 'investmentPeriod',
      title: `${period.displayLabel} Investments`,
      ids: new Set(period.transactionIds)
    });
  };

  return (
    <div className="page analytics-page stagger-in">
      <div className="page__header analytics-page__header">
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
              value={categoryFilterId}
              onChange={(event) => handleCategoryFilterChange(event.target.value)}
              aria-label="Category filter"
            >
              <option value="">All Categories</option>
              <option value="uncategorized">Uncategorized</option>
              {categories
                .filter(category => category.name.toLowerCase() !== 'uncategorized')
                .map(category => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </div>

          <div className="date-range-selector">
            <Calendar size={18} className="text-muted" />
            <select 
              className="input input--sm"
              value={dateRange}
              onChange={(e) => handleDateRangeChange(e.target.value)}
            >
              {Object.values(DATE_RANGES).map(range => (
                <option key={range} value={range}>{range}</option>
              ))}
            </select>
          </div>

          <div className="date-navigator" aria-label="Date range navigation">
            <button
              className="btn btn--ghost btn--icon"
              type="button"
              disabled={!startDate || !endDate}
              onClick={() => handleShiftMonthWindow(-1)}
              aria-label="Previous month range"
              title="Previous month range"
            >
              <ChevronLeft size={16} />
            </button>
            <div className="date-navigator__label" title={activeDateLabel}>
              {activeDateLabel}
            </div>
            <button
              className="btn btn--ghost btn--icon"
              type="button"
              disabled={!startDate || !endDate}
              onClick={() => handleShiftMonthWindow(1)}
              aria-label="Next month range"
              title="Next month range"
            >
              <ChevronRight size={16} />
            </button>
            <button
              className="btn btn--ghost btn--icon"
              type="button"
              onClick={handleResetToCurrentMonth}
              aria-label="Reset to this month"
              title="Reset to this month"
            >
              <RotateCcw size={15} />
            </button>
          </div>

          {dateRange === DATE_RANGES.CUSTOM && (
            <div className="date-range-selector date-range-selector--custom">
              <input
                className="input input--sm"
                type="date"
                value={customStartDate}
                onChange={(event) => {
                  setCustomStartDate(event.target.value);
                  resetAnalyticsSelection();
                }}
                aria-label="Start date"
              />
              <span>to</span>
              <input
                className="input input--sm"
                type="date"
                value={customEndDate}
                onChange={(event) => {
                  setCustomEndDate(event.target.value);
                  resetAnalyticsSelection();
                }}
                aria-label="End date"
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

      {filteredInternalMovement > 0 && (
        <div className="analytics-scope-note">
          <span>
            Internal money movement totaling {formatCurrency(filteredInternalMovement)} is excluded from spending and net flow,
            including credit card payments and transfers between your own accounts.
          </span>
        </div>
      )}

      <div className="analytics-summary grid-4">
        <div className="glass-card kpi-card">
          <div className="kpi-card__label">Total Income</div>
          <div className="kpi-card__value amount amount--positive">{formatCurrency(totalIncome)}</div>
        </div>
        <div className="glass-card kpi-card">
          <div className="kpi-card__label">Total Expense</div>
          <div className="kpi-card__value amount amount--negative">{formatCurrency(totalExpense)}</div>
        </div>
        <div className="glass-card kpi-card">
          <div className="kpi-card__label analytics-kpi-label">
            <span>Total Investments</span>
            <Tooltip
              text="Investment transactions are tracked separately and do not subtract from net flow."
              position="top"
            >
              <span className="analytics-help-icon" tabIndex={0} aria-label="Investment total help">
                <HelpCircle size={14} />
              </span>
            </Tooltip>
          </div>
          <div className="kpi-card__value amount amount--investment">{formatCurrency(filteredInvestments)}</div>
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
            onSelectCategory={(category) => handleCategoryFilterChange(String(category.id))}
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
            transactions={categoryScopedTransactions}
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
                  const key = row.groupMode === CASH_FLOW_GROUPS.YEAR
                    ? format(dateObj, 'yyyy')
                    : row.groupMode === CASH_FLOW_GROUPS.MONTH
                      ? format(dateObj, 'yyyy-MM')
                      : row.groupMode === CASH_FLOW_GROUPS.WEEK
                        ? format(startOfWeek(dateObj), 'yyyy-MM-dd')
                        : format(dateObj, 'yyyy-MM-dd');
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
                {Math.min(drilldownVisibleCount, visibleDrilldownTransactions.length)} shown
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
                onChange={(event) => {
                  setDrilldownSearch(event.target.value);
                  setDrilldownVisibleCount(DRILLDOWN_PAGE_SIZE);
                }}
                placeholder="Search matching transactions"
              />
            </label>
            <select
              className="input input--sm drilldown-sort"
              value={drilldownSort}
              onChange={(event) => {
                setDrilldownSort(event.target.value);
                setDrilldownVisibleCount(DRILLDOWN_PAGE_SIZE);
              }}
            >
              <option value="date_desc">Newest first</option>
              <option value="date_asc">Oldest first</option>
              <option value="amount_desc">Highest cost first</option>
              <option value="amount_asc">Lowest cost first</option>
            </select>
          </div>
          <div className="drilldown-list drilldown-list--scrollable" onScroll={handleDrilldownScroll}>
            {loadedDrilldownTransactions.map(transaction => (
              <div key={transaction.id} className="drilldown-row">
                <span>{formatDate(transaction.date, 'medium')}</span>
                <strong className="truncate">{transaction.merchant || transaction.description}</strong>
                <span>{categoryMap[transaction.categoryId]?.name || 'Uncategorized'}</span>
                <span className={`amount ${getAmountClass(transaction.amount)}`}>{formatCurrency(transaction.amount, true)}</span>
              </div>
            ))}
            {hasMoreDrilldownTransactions && (
              <div className="drilldown-footer">Scroll to load more transactions.</div>
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
