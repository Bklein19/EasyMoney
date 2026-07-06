import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, UIEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addMonths, endOfDay, endOfMonth, endOfWeek, endOfYear, format, parseISO, startOfMonth, startOfWeek, startOfYear, subMonths, subWeeks } from 'date-fns';
import { Calendar, ChevronLeft, ChevronRight, HelpCircle, Landmark, Maximize2, RotateCcw, Search, X } from 'lucide-react';
import { useCategories } from '../../hooks/useCategories';
import { useAccounts } from '../../hooks/useAccounts';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import { formatCurrency, formatDate, getAmountClass } from '../../utils/formatters';

import SpendingByCategory from './SpendingByCategory';
import SpendingTrends from './SpendingTrends';
import IncomeVsExpense from './IncomeVsExpense';
import TopMerchants from './TopMerchants';
import IncomeStreams from './IncomeStreams';
import InvestmentTrends from './InvestmentTrends';
import Tooltip from '../shared/Tooltip';
import Modal from '../shared/Modal';
import GroupedCategorySelect, { isUncategorized } from '../shared/GroupedCategorySelect';
import type { AnalyticsGroupMode, CategoryFilterMode } from '../../../server/app/analytics.ts';
import type { CategorySummary, TransactionListItem } from '../../../server/app/types.ts';
import type { AnalyticsPeriodRow } from './PeriodClickOverlay';

import './Analytics.css';

const DATE_RANGES = {
  THIS_MONTH: 'This Month',
  LAST_MONTH: 'Last Month',
  LAST_WEEK: 'Last Week',
  THIS_YEAR: 'This Year',
  CUSTOM: 'Custom',
  ALL_TIME: 'All Time'
} as const;

const CASH_FLOW_GROUPS = {
  AUTO: 'Auto',
  DAY: 'Daily',
  WEEK: 'Weekly',
  MONTH: 'Monthly',
  YEAR: 'Yearly'
} as const;

const DRILLDOWN_PAGE_SIZE = 20;
const CATEGORY_FILTER_MODES = {
  INCLUDE: 'include',
  EXCLUDE: 'exclude'
} as const;

type DateRange = typeof DATE_RANGES[keyof typeof DATE_RANGES];
type CategoryFilterModeValue = typeof CATEGORY_FILTER_MODES[keyof typeof CATEGORY_FILTER_MODES];
type CategoryFilterIdsByMode = Record<CategoryFilterModeValue, string[]>;
type DrilldownSort = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';
type ExpandedChart = 'incomeExpense' | 'spendingTrends' | null;

interface UiTransaction extends TransactionListItem {
  accountId: number | null;
  categoryId: number | null;
}

interface AnalyticsSummary {
  income: number;
  expenses: number;
  internalMovement: number;
  investments: number;
  net: number;
}

interface CashFlowRow extends AnalyticsPeriodRow {
  key: string;
  label: string;
  startDate: string;
  endDate: string;
  income: number;
  expenses: number;
  net: number;
  categoryAmounts: Record<string, number>;
  transactionIds: number[];
}

interface SpendingCategoryRow {
  id: string | number;
  name: string;
  amount: number;
  color?: string | null;
  transactionIds?: Array<string | number>;
}

interface MerchantAnalyticsRow {
  normalized: string;
  name: string;
  amount: number;
  count: number;
  transactionIds: number[];
}

interface InvestmentPeriodRow extends AnalyticsPeriodRow {
  key: string;
  label: string;
  amount: number;
  transactionIds: number[];
  displayLabel?: string;
}

interface AnalyticsReport {
  summary: AnalyticsSummary;
  cashFlow: CashFlowRow[];
  spendingByCategory: SpendingCategoryRow[];
  topMerchants: MerchantAnalyticsRow[];
  incomeStreams: MerchantAnalyticsRow[];
  investments: InvestmentPeriodRow[];
  transactions: TransactionListItem[];
  analysisTransactions: TransactionListItem[];
}

interface DrilldownState {
  type: 'category' | 'merchant' | 'incomeStream' | 'period' | 'investmentPeriod';
  id?: string;
  title: string;
  ids: Set<string | number>;
  aliases?: string[];
  scrollIntoView?: boolean;
}

interface AddCategoryFilterOptions {
  resetSelection?: boolean;
}

const toDateInput = (date: Date) => format(date, 'yyyy-MM-dd');

function toUiTransaction(transaction: TransactionListItem): UiTransaction {
  return {
    ...transaction,
    accountId: transaction.account?.id ?? null,
    categoryId: transaction.category?.id ?? null,
  };
}

function getMonthSpan(startDate: string, endDate: string) {
  const start = parseISO(startDate);
  const end = parseISO(endDate);
  return Math.max(1, ((end.getFullYear() - start.getFullYear()) * 12) + end.getMonth() - start.getMonth() + 1);
}

function isCategoryFilterMode(value: string): value is CategoryFilterModeValue {
  return value === CATEGORY_FILTER_MODES.INCLUDE || value === CATEGORY_FILTER_MODES.EXCLUDE;
}

function isAnalyticsGroupMode(value: string): value is AnalyticsGroupMode {
  return Object.values(CASH_FLOW_GROUPS).includes(value as AnalyticsGroupMode);
}

function isDateRange(value: string): value is DateRange {
  return Object.values(DATE_RANGES).includes(value as DateRange);
}

export default function AnalyticsPage() {
  const [dateRange, setDateRange] = useState<DateRange>(DATE_RANGES.ALL_TIME);
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [accountId, setAccountId] = useState('');
  const [categoryFilterIdsByMode, setCategoryFilterIdsByMode] = useState<CategoryFilterIdsByMode>({
    [CATEGORY_FILTER_MODES.INCLUDE]: [],
    [CATEGORY_FILTER_MODES.EXCLUDE]: []
  });
  const [categoryFilterMode, setCategoryFilterMode] = useState<CategoryFilterModeValue>(CATEGORY_FILTER_MODES.INCLUDE);
  const [pendingCategoryFilterId, setPendingCategoryFilterId] = useState('');
  const [cashFlowGroup, setCashFlowGroup] = useState<AnalyticsGroupMode>(CASH_FLOW_GROUPS.AUTO);
  const [drilldown, setDrilldown] = useState<DrilldownState | null>(null);
  const [drilldownSearch, setDrilldownSearch] = useState('');
  const [drilldownSort, setDrilldownSort] = useState<DrilldownSort>('date_desc');
  const [isCreatingDrilldownCategory, setIsCreatingDrilldownCategory] = useState(false);
  const [newDrilldownCategoryName, setNewDrilldownCategoryName] = useState('');
  const [pendingDrilldownCategoryValue, setPendingDrilldownCategoryValue] = useState<string | null>(null);
  const [drilldownVisibleCount, setDrilldownVisibleCount] = useState(DRILLDOWN_PAGE_SIZE);
  const [expandedChart, setExpandedChart] = useState<ExpandedChart>(null);
  const [showTotalSpendTrend, setShowTotalSpendTrend] = useState(false);
  const drilldownRef = useRef<HTMLDivElement | null>(null);
  
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

  const { categories, addCategory } = useCategories();
  const { accounts } = useAccounts();
  const categoryFilterIds = useMemo(
    () => categoryFilterIdsByMode[categoryFilterMode] || [],
    [categoryFilterIdsByMode, categoryFilterMode]
  );
  const analyticsInput = useMemo(() => ({
    startDate,
    endDate,
    accountId: accountId || null,
    categoryFilterIds,
    categoryFilterMode: categoryFilterMode as CategoryFilterMode,
    groupMode: cashFlowGroup,
  }), [accountId, cashFlowGroup, categoryFilterIds, categoryFilterMode, endDate, startDate]);
  const analyticsReportQuery = useQuery(trpc.analytics.report.queryOptions(analyticsInput));
  const analyticsReport = analyticsReportQuery.data as AnalyticsReport | undefined;
  const reportTransactions = useMemo(
    () => (analyticsReport?.transactions ?? []).map(toUiTransaction),
    [analyticsReport?.transactions]
  );
  const reportAnalysisTransactions = useMemo(
    () => (analyticsReport?.analysisTransactions ?? []).map(toUiTransaction),
    [analyticsReport?.analysisTransactions]
  );
  const reportSummary = analyticsReport?.summary ?? {
    income: 0,
    expenses: 0,
    internalMovement: 0,
    investments: 0,
    net: 0,
  };
  const deferredTransactions = useDeferredValue(reportTransactions);
  const deferredAnalysisTransactions = useDeferredValue(reportAnalysisTransactions);
  const deferredAccounts = useDeferredValue(accounts);
  const deferredCategories = useDeferredValue(categories);
  const deferredCashFlow = useDeferredValue(analyticsReport?.cashFlow ?? []);
  const deferredSpendingByCategory = useDeferredValue(analyticsReport?.spendingByCategory ?? []);
  const deferredTopMerchants = useDeferredValue(analyticsReport?.topMerchants ?? []);
  const deferredIncomeStreams = useDeferredValue(analyticsReport?.incomeStreams ?? []);
  const deferredInvestments = useDeferredValue(analyticsReport?.investments ?? []);
  const deferredCategoryFilterIds = useDeferredValue(categoryFilterIds);
  const deferredCategoryFilterMode = useDeferredValue(categoryFilterMode);
  const deferredCashFlowGroup = useDeferredValue(cashFlowGroup);
  const isAnalyticsWorking =
    analyticsReportQuery.isFetching ||
    reportTransactions !== deferredTransactions ||
    reportAnalysisTransactions !== deferredAnalysisTransactions ||
    (analyticsReport?.cashFlow ?? []) !== deferredCashFlow ||
    (analyticsReport?.spendingByCategory ?? []) !== deferredSpendingByCategory ||
    (analyticsReport?.topMerchants ?? []) !== deferredTopMerchants ||
    (analyticsReport?.incomeStreams ?? []) !== deferredIncomeStreams ||
    (analyticsReport?.investments ?? []) !== deferredInvestments ||
    accounts !== deferredAccounts ||
    categories !== deferredCategories ||
    categoryFilterIds !== deferredCategoryFilterIds ||
    categoryFilterMode !== deferredCategoryFilterMode ||
    cashFlowGroup !== deferredCashFlowGroup;

  // Create a fast map for category lookup
  const categoryMap = useMemo(() => {
    const map: Record<string, CategorySummary> = {};
    deferredCategories.forEach(c => { map[c.id] = c; });
    return map;
  }, [deferredCategories]);

  const categoryScopedTransactions = deferredTransactions;
  const analysisTransactions = deferredAnalysisTransactions;
  const totalIncome = reportSummary.income;
  const totalExpense = reportSummary.expenses;
  const filteredInternalMovement = reportSummary.internalMovement;
  const filteredInvestments = reportSummary.investments;
  const cashFlowRows = useMemo(() => [...deferredCashFlow].sort((a, b) => b.key.localeCompare(a.key)), [deferredCashFlow]);

  const drilldownTransactions = useMemo(() => {
    if (!drilldown) return [];
    const sourceTransactions = drilldown.type === 'investmentPeriod' ? categoryScopedTransactions : analysisTransactions;

    return sourceTransactions.filter(t => {
      if (drilldown.type === 'category') {
        return drilldown.ids?.has(t.id);
      }
      if (drilldown.type === 'merchant') {
        return drilldown.ids?.has(t.id);
      }
      if (drilldown.type === 'incomeStream') {
        return drilldown.ids?.has(t.id);
      }
      if (drilldown.type === 'period') {
        return drilldown.ids.has(t.id);
      }
      if (drilldown.type === 'investmentPeriod') {
        return drilldown.ids.has(t.id);
      }
      return false;
    });
  }, [analysisTransactions, categoryScopedTransactions, drilldown]);

  const visibleDrilldownTransactions = useMemo(() => {
    const query = drilldownSearch.trim().toLowerCase();
    const searched = query
      ? drilldownTransactions.filter(transaction => {
        const categoryName = transaction.categoryId ? categoryMap[String(transaction.categoryId)]?.name || 'Uncategorized' : 'Uncategorized';
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

  const drilldownFilteredTotal = useMemo(() => {
    return visibleDrilldownTransactions.reduce((sum, transaction) => sum + transaction.amount, 0);
  }, [visibleDrilldownTransactions]);

  const hasMoreDrilldownTransactions = drilldownVisibleCount < visibleDrilldownTransactions.length;

  useEffect(() => {
    if (!drilldown?.scrollIntoView) return;
    drilldownRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [drilldown]);

  const confirmLargeDrilldownChange = (count: number, categoryName: string) => {
    if (count <= 50) return true;
    return window.confirm(
      `This will set the category for ${count} visible drilldown transactions to "${categoryName}". This is a bulk edit and cannot be automatically undone.\n\nContinue?`
    );
  };

  const handleBulkCategoryChange = async (categoryId: string | number | null) => {
    const nextCategoryId = categoryId ? Number(categoryId) : null;
    await trpcClient.transactions.categorize.mutate({
      transactionIds: visibleDrilldownTransactions.map(transaction => transaction.id),
      categoryId: nextCategoryId,
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.analytics.report.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: ['app', 'transactions', 'infinite'] }),
    ]);
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

  const handleCreateDrilldownCategory = async (event: FormEvent<HTMLFormElement>) => {
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

  const openDrilldown = (nextDrilldown: DrilldownState) => {
    setDrilldownSearch('');
    setDrilldownSort('date_desc');
    setPendingDrilldownCategoryValue(null);
    setDrilldownVisibleCount(DRILLDOWN_PAGE_SIZE);
    setDrilldown(nextDrilldown);
  };

  const handlePeriodSelect = (period: AnalyticsPeriodRow) => {
    if (typeof period.startDate === 'string' && typeof period.endDate === 'string') {
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

  const handleDrilldownScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!hasMoreDrilldownTransactions) return;

    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 96) {
      setDrilldownVisibleCount(previous =>
        Math.min(previous + DRILLDOWN_PAGE_SIZE, visibleDrilldownTransactions.length)
      );
    }
  };

  const handleDateRangeChange = (nextRange: DateRange) => {
    if (nextRange === DATE_RANGES.CUSTOM && !customStartDate && !customEndDate) {
      const today = new Date();
      setCustomStartDate(toDateInput(startOfMonth(today)));
      setCustomEndDate(toDateInput(endOfMonth(today)));
    }

    setDateRange(nextRange);
    resetAnalyticsSelection();
  };

  const addCategoryFilter = (categoryId: string, mode: CategoryFilterModeValue = categoryFilterMode, options: AddCategoryFilterOptions = {}) => {
    if (!categoryId) return;
    setCategoryFilterMode(mode);
    setCategoryFilterIdsByMode(previous => {
      const current = previous[mode] || [];
      return {
        ...previous,
        [mode]: current.includes(categoryId) ? current : [...current, categoryId]
      };
    });
    setPendingCategoryFilterId('');
    if (options.resetSelection !== false) resetAnalyticsSelection();
  };

  const includeCategoryFromChart = (category: SpendingCategoryRow) => {
    const categoryId = String(category.id);
    addCategoryFilter(categoryId, CATEGORY_FILTER_MODES.INCLUDE, { resetSelection: false });
    openDrilldown({
      type: 'category',
      id: categoryId,
      ids: new Set(category.transactionIds),
      title: `${category.name} Spending`,
      scrollIntoView: true
    });
  };

  const excludeCategoryFromChart = (categoryId: string) => {
    addCategoryFilter(categoryId, CATEGORY_FILTER_MODES.EXCLUDE);
  };

  const removeCategoryFilter = (categoryId: string) => {
    setCategoryFilterIdsByMode(previous => ({
      ...previous,
      [categoryFilterMode]: (previous[categoryFilterMode] || []).filter(id => id !== categoryId)
    }));
    resetAnalyticsSelection();
  };

  const clearCategoryFilters = () => {
    setCategoryFilterIdsByMode(previous => ({
      ...previous,
      [categoryFilterMode]: []
    }));
    setPendingCategoryFilterId('');
    resetAnalyticsSelection();
  };

  const handleCategoryFilterModeChange = (nextMode: CategoryFilterModeValue) => {
    setCategoryFilterMode(nextMode);
    setPendingCategoryFilterId('');
    resetAnalyticsSelection();
  };

  const getCategoryFilterLabel = (categoryId: string) => {
    if (categoryId === 'uncategorized') return 'Uncategorized';
    return categories.find(category => String(category.id) === categoryId)?.name || 'Unknown category';
  };

  const handleShiftMonthWindow = (direction: number) => {
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

  const handleInvestmentPeriodSelect = (period: AnalyticsPeriodRow) => {
    const investmentPeriod = period as InvestmentPeriodRow;
    openDrilldown({
      type: 'investmentPeriod',
      title: `${investmentPeriod.displayLabel || investmentPeriod.label} Investments`,
      ids: new Set(investmentPeriod.transactionIds)
    });
  };

  const renderAnalyticsFilters = (variant = 'page') => (
    <div className={`analytics-controls analytics-controls--${variant}`}>
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

      <div className="category-filter-control">
        <div className="category-filter-control__row">
          <select
            className="input input--sm"
            value={categoryFilterMode}
            onChange={(event) => {
              if (isCategoryFilterMode(event.target.value)) handleCategoryFilterModeChange(event.target.value);
            }}
            aria-label="Category filter mode"
          >
            <option value={CATEGORY_FILTER_MODES.INCLUDE}>Include categories</option>
            <option value={CATEGORY_FILTER_MODES.EXCLUDE}>Exclude categories</option>
          </select>
          <select
            className="input input--sm"
            value={pendingCategoryFilterId}
            onChange={(event) => addCategoryFilter(event.target.value)}
            aria-label="Add category filter"
          >
            <option value="">
              {categoryFilterIds.length === 0 ? 'All Categories' : 'Add Category'}
            </option>
            <option value="uncategorized" disabled={categoryFilterIds.includes('uncategorized')}>
              Uncategorized
            </option>
            {categories
              .filter(category => category.name.toLowerCase() !== 'uncategorized')
              .map(category => {
                const id = String(category.id);
                return (
                  <option key={category.id} value={id} disabled={categoryFilterIds.includes(id)}>
                    {category.name}
                  </option>
                );
              })}
          </select>
        </div>
        {categoryFilterIds.length > 0 && (
          <div className="category-filter-chips" aria-label="Active category filters">
            {categoryFilterIds.map(categoryId => (
              <button
                key={categoryId}
                className="category-filter-chip"
                type="button"
                onClick={() => removeCategoryFilter(categoryId)}
                aria-label={`Remove ${getCategoryFilterLabel(categoryId)} category filter`}
              >
                <span>
                  {categoryFilterMode === CATEGORY_FILTER_MODES.EXCLUDE ? 'Excluding ' : ''}
                  {getCategoryFilterLabel(categoryId)}
                </span>
                <X size={13} />
              </button>
            ))}
            <button className="category-filter-clear" type="button" onClick={clearCategoryFilters}>
              Clear
            </button>
          </div>
        )}
      </div>

      <div className="date-range-selector">
        <Calendar size={18} className="text-muted" />
        <select
          className="input input--sm"
          value={dateRange}
          onChange={(e) => {
            if (isDateRange(e.target.value)) handleDateRangeChange(e.target.value);
          }}
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
          onChange={(e) => {
            if (isAnalyticsGroupMode(e.target.value)) setCashFlowGroup(e.target.value);
          }}
        >
          {Object.values(CASH_FLOW_GROUPS).map(group => (
            <option key={group} value={group}>{group}</option>
          ))}
        </select>
      </div>
    </div>
  );

  const renderAnalyticsWorking = () => isAnalyticsWorking && (
    <div className="analytics-working" role="status" aria-live="polite">
      <span className="analytics-working__spinner" aria-hidden="true" />
      <span>Recalculating analytics...</span>
    </div>
  );

  return (
    <div className="page analytics-page stagger-in">
      <div className="page__header analytics-page__header">
        <div>
          <h1 className="page__title">Analytics</h1>
          <p className="page__subtitle">Insights into your financial habits</p>
        </div>

        {renderAnalyticsFilters()}
        {renderAnalyticsWorking()}
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
          <div className="analytics-chart-header">
            <h3 className="analytics-card__title">Income vs Expense</h3>
            <button
              className="btn btn--ghost btn--icon btn--sm"
              type="button"
              onClick={() => setExpandedChart('incomeExpense')}
              aria-label="Expand Income vs Expense chart"
            >
              <Maximize2 size={16} />
            </button>
          </div>
          <IncomeVsExpense
            rows={cashFlowRows}
            onSelectPeriod={handlePeriodSelect}
          />
        </div>
        
        <div className="analytics-card glass-card">
          <div className="analytics-chart-header">
            <h3 className="analytics-card__title">Spending Trends</h3>
            <div className="analytics-chart-actions">
              <label className="analytics-chart-toggle">
                <input
                  type="checkbox"
                  checked={showTotalSpendTrend}
                  onChange={(event) => setShowTotalSpendTrend(event.target.checked)}
                />
                <span>Total Spend</span>
              </label>
              <button
                className="btn btn--ghost btn--icon btn--sm"
                type="button"
                onClick={() => setExpandedChart('spendingTrends')}
                aria-label="Expand Spending Trends chart"
              >
                <Maximize2 size={16} />
              </button>
            </div>
          </div>
          <SpendingTrends
            rows={cashFlowRows}
            showTotalSpend={showTotalSpendTrend}
            onSelectPeriod={handlePeriodSelect}
          />
        </div>

        <div className="analytics-card glass-card">
          <div className="analytics-card__heading">
            <h3 className="analytics-card__title">Spending by Category</h3>
            <p>
              Click a category to include it. Hover and use X to exclude it.
            </p>
          </div>
          <SpendingByCategory
            rows={deferredSpendingByCategory}
            onSelectCategory={(category) => includeCategoryFromChart(category)}
            onExcludeCategory={(category) => excludeCategoryFromChart(String(category.id))}
          />
        </div>
        
        <div className="analytics-card glass-card">
          <h3 className="analytics-card__title">Top Merchants</h3>
          <TopMerchants
            rows={deferredTopMerchants}
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
            rows={deferredIncomeStreams}
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
            rows={deferredInvestments}
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
                scrollIntoView: true,
                ids: new Set(row.transactionIds)
              })}
            >
              <span>{row.label}</span>
              <span className="amount amount--positive">{formatCurrency(row.income)}</span>
              <span className="amount amount--negative">{formatCurrency(row.expenses)}</span>
              <span className={`amount ${getAmountClass(row.net)}`}>{formatCurrency(row.net, true)}</span>
              <span>{row.transactionIds.length} tx</span>
            </button>
          )) : (
            <div className="empty-state-simple">No cash flow data for this period.</div>
          )}
        </div>
      </div>

      {drilldown && (
        <div className="analytics-card glass-card analytics-drilldown" ref={drilldownRef}>
          <div className="analytics-drilldown__header">
            <div>
              <h3 className="analytics-card__title">{drilldown.title}</h3>
              <p>
                {Math.min(drilldownVisibleCount, visibleDrilldownTransactions.length)} shown
                {visibleDrilldownTransactions.length !== drilldownTransactions.length && ` of ${drilldownTransactions.length}`}
                {' '}matching transaction{visibleDrilldownTransactions.length === 1 ? '' : 's'}
              </p>
              <div className="drilldown-total">
                <span>Filtered total</span>
                <strong className={`amount ${getAmountClass(drilldownFilteredTotal)}`}>
                  {formatCurrency(drilldownFilteredTotal, true)}
                </strong>
              </div>
              {(drilldown.aliases?.length ?? 0) > 1 && (
                <div className="drilldown-aliases">
                  {(drilldown.aliases ?? []).slice(0, 6).map(alias => (
                    <span key={alias}>{alias}</span>
                  ))}
                  {(drilldown.aliases?.length ?? 0) > 6 && <span>+{(drilldown.aliases?.length ?? 0) - 6} more</span>}
                </div>
              )}
            </div>
            <div className="bulk-category-action drilldown-actions">
              <div>
                <label htmlFor="bulkCategory">Bulk category edit</label>
                <p>Applies to all {visibleDrilldownTransactions.length} visible drilldown rows.</p>
              </div>
              <GroupedCategorySelect
                id="bulkCategory"
                className="input input--sm"
                value={drilldownCategorySelectValue}
                disabled={visibleDrilldownTransactions.length === 0}
                categories={categories.filter(category => !isUncategorized(category))}
                leadingOptions={[
                  ...(drilldownCategoryValue === '__mixed__'
                    ? [{ value: '__mixed__', label: 'Mixed categories' }]
                    : []),
                  { value: '', label: 'Uncategorized' },
                ]}
                trailingOptions={[{ value: '__add_custom__', label: '+ Add custom category' }]}
                onChange={(value) => {
                  if (value === '__add_custom__') {
                    setIsCreatingDrilldownCategory(true);
                    return;
                  }
                  resetDrilldownCategoryCreate();
                  setPendingDrilldownCategoryValue(value);
                }}
              />
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
                const value = event.target.value;
                if (value === 'date_desc' || value === 'date_asc' || value === 'amount_desc' || value === 'amount_asc') {
                  setDrilldownSort(value);
                }
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
                <span>{transaction.categoryId ? categoryMap[String(transaction.categoryId)]?.name || 'Uncategorized' : 'Uncategorized'}</span>
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

      <Modal
        isOpen={expandedChart === 'incomeExpense'}
        onClose={() => setExpandedChart(null)}
        title="Income vs Expense"
        maxWidth="calc(100vw - 48px)"
        className="modal-container--fullscreen"
      >
        {renderAnalyticsFilters('modal')}
        {renderAnalyticsWorking()}
        <div className="analytics-expanded-chart">
          <IncomeVsExpense
            rows={cashFlowRows}
            onSelectPeriod={(period) => {
              setExpandedChart(null);
              handlePeriodSelect(period);
            }}
          />
        </div>
      </Modal>

      <Modal
        isOpen={expandedChart === 'spendingTrends'}
        onClose={() => setExpandedChart(null)}
        title="Spending Trends"
        maxWidth="calc(100vw - 48px)"
        className="modal-container--fullscreen"
      >
        {renderAnalyticsFilters('modal')}
        {renderAnalyticsWorking()}
        <div className="analytics-modal-toolbar">
          <label className="analytics-chart-toggle">
            <input
              type="checkbox"
              checked={showTotalSpendTrend}
              onChange={(event) => setShowTotalSpendTrend(event.target.checked)}
            />
            <span>Show Total Spend</span>
          </label>
        </div>
        <div className="analytics-expanded-chart">
          <SpendingTrends
            rows={cashFlowRows}
            showTotalSpend={showTotalSpendTrend}
            onSelectPeriod={(period) => {
              setExpandedChart(null);
              handlePeriodSelect(period);
            }}
          />
        </div>
      </Modal>
    </div>
  );
}
