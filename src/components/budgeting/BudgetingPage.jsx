import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addMonths, differenceInCalendarDays, endOfDay, endOfMonth, endOfYear, format, parseISO, startOfMonth, startOfYear } from 'date-fns';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { ArrowDown, ArrowUp, Calendar, CheckCircle2, CircleAlert, PiggyBank, RotateCcw, Target, Wand2 } from 'lucide-react';
import { useBudgets } from '../../hooks/useBudgets';
import { useCategories } from '../../hooks/useCategories';
import { trpc } from '../../api/trpc';
import { formatCurrency } from '../../utils/formatters';
import Modal from '../shared/Modal';
import './BudgetingPage.css';

const toMonthKey = (date) => format(date, 'yyyy-MM');
const toDateInput = (date) => format(date, 'yyyy-MM-dd');
const clampPercent = (value) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
const formatPercentValue = (value) => `${value.toFixed(value >= 10 || value === 0 ? 0 : 1)}%`;
const PERIOD_MODES = {
  MONTH: 'month',
  YEAR: 'year',
  CUSTOM: 'custom'
};
const DREAM_BUDGET_KEY = 'easymoney:dream-budget';
const SAVED_BUDGETS_KEY = 'easymoney:saved-budgets';
const AVERAGE_DAYS_PER_MONTH = 365.2425 / 12;

function getStoredGlobalBudget(periodKey) {
  const value = window.localStorage.getItem(`easymoney:global-budget:${periodKey}`);
  if (!value) return '';
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? String(numberValue) : '';
}

function getStoredDreamBudget() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(DREAM_BUDGET_KEY) || '{}');
    return {
      globalBudget: Number(stored.globalBudget) > 0 ? Number(stored.globalBudget) : 0,
      categoryPercents: stored.categoryPercents && typeof stored.categoryPercents === 'object'
        ? stored.categoryPercents
        : {}
    };
  } catch {
    return { globalBudget: 0, categoryPercents: {} };
  }
}

function getStoredSavedBudgets() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SAVED_BUDGETS_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function BudgetTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const item = payload[0];

  return (
    <div className="custom-tooltip">
      <div className="custom-tooltip__item">
        <span className="custom-tooltip__dot" style={{ background: item.payload.color }} />
        <span>{item.name}: {formatCurrency(item.value)}</span>
      </div>
    </div>
  );
}

export default function BudgetingPage() {
  const today = new Date();
  const [periodMode, setPeriodMode] = useState(PERIOD_MODES.MONTH);
  const [month, setMonth] = useState(() => toMonthKey(new Date()));
  const [year, setYear] = useState(() => String(new Date().getFullYear()));
  const [customStartDate, setCustomStartDate] = useState(() => toDateInput(startOfMonth(today)));
  const [customEndDate, setCustomEndDate] = useState(() => toDateInput(endOfMonth(today)));
  const [globalBudgetByPeriod, setGlobalBudgetByPeriod] = useState(() => {
    const currentMonth = toMonthKey(new Date());
    return { [`month:${currentMonth}`]: getStoredGlobalBudget(`month:${currentMonth}`) };
  });
  const [dreamBudget, setDreamBudget] = useState(getStoredDreamBudget);
  const [savedBudgets, setSavedBudgets] = useState(getStoredSavedBudgets);
  const [selectedSavedBudgetId, setSelectedSavedBudgetId] = useState('');
  const [isDesigningBudget, setIsDesigningBudget] = useState(false);
  const [isSavingPeriodBudget, setIsSavingPeriodBudget] = useState(false);
  const [draftDreamBudget, setDraftDreamBudget] = useState(() => getStoredDreamBudget());
  const [draftBudgetName, setDraftBudgetName] = useState('Budget Template');
  const [periodBudgetName, setPeriodBudgetName] = useState('');
  const [savingCategoryId, setSavingCategoryId] = useState(null);

  const period = useMemo(() => {
    if (periodMode === PERIOD_MODES.YEAR) {
      const yearDate = parseISO(`${year}-01-01`);
      return {
        key: `year:${year}`,
        label: year,
        scale: 12,
        startDate: startOfYear(yearDate).toISOString(),
        endDate: endOfYear(yearDate).toISOString()
      };
    }

    if (periodMode === PERIOD_MODES.CUSTOM) {
      const start = parseISO(customStartDate);
      const end = endOfDay(parseISO(customEndDate));
      const dayCount = Math.max(1, differenceInCalendarDays(end, start) + 1);
      return {
        key: `custom:${customStartDate}:${customEndDate}`,
        label: `${format(start, 'MMM d, yyyy')} - ${format(parseISO(customEndDate), 'MMM d, yyyy')}`,
        scale: dayCount / AVERAGE_DAYS_PER_MONTH,
        startDate: start.toISOString(),
        endDate: end.toISOString()
      };
    }

    const monthDate = parseISO(`${month}-01`);
    return {
      key: `month:${month}`,
      label: format(monthDate, 'MMMM yyyy'),
      scale: 1,
      startDate: startOfMonth(monthDate).toISOString(),
      endDate: endOfMonth(monthDate).toISOString()
    };
  }, [customEndDate, customStartDate, month, periodMode, year]);

  const globalBudgetInput = globalBudgetByPeriod[period.key] || '';
  const isMonthlyPeriod = periodMode === PERIOD_MODES.MONTH;

  const { expenseCategories } = useCategories();
  const { setBudget } = useBudgets(isMonthlyPeriod ? month : undefined);
  const manualGlobalBudget = Number(globalBudgetInput);
  const explicitGlobalBudget = Number.isFinite(manualGlobalBudget) && manualGlobalBudget > 0
    ? manualGlobalBudget
    : dreamBudget.globalBudget > 0
      ? dreamBudget.globalBudget * period.scale
      : null;
  const hasDreamTargets = Object.values(dreamBudget.categoryPercents).some(value => Number(value) > 0);
  const budgetReportQuery = useQuery(trpc.budgets.report.queryOptions({
    startDate: period.startDate,
    endDate: period.endDate,
    month: isMonthlyPeriod ? month : null,
    globalBudget: explicitGlobalBudget,
    categoryPercents: hasDreamTargets ? dreamBudget.categoryPercents : null,
  }));
  const budgetReport = budgetReportQuery.data;
  const cashFlow = budgetReport?.cashFlow ?? { income: 0, expenses: 0, byCategory: {} };
  const autoGlobalBudget = cashFlow.income > 0 ? cashFlow.income : cashFlow.expenses;
  const globalBudget = budgetReport?.globalBudget ?? 0;
  const rows = budgetReport?.rows ?? [];
  const targetTotalPercent = budgetReport?.summary?.targetTotalPercent ?? 0;
  const overRows = rows.filter(row => row.status === 'over');
  const unplannedRows = rows.filter(row => row.status === 'unplanned');
  const actualSpendPercent = budgetReport?.summary?.actualSpendPercent ?? 0;
  const budgetRemaining = budgetReport?.summary?.budgetRemaining ?? 0;
  const unspentIncome = budgetReport?.summary?.unspentIncome ?? 0;
  const overspentAmount = budgetReport?.summary?.overspentAmount ?? 0;
  const spendingAllocationData = rows
    .filter(row => row.actual > 0)
    .map(row => ({
      name: row.category.name,
      value: row.actual,
      color: row.category.color || '#94a3b8'
    }));
  const allocationData = [
    ...spendingAllocationData,
    ...(unspentIncome > 0 ? [{ name: 'Unspent', value: unspentIncome, color: '#10b981' }] : [])
  ];
  const allocationTotal = allocationData.reduce((sum, item) => sum + item.value, 0);
  const incomeCoveragePercent = cashFlow.expenses > 0
    ? Math.min(100, (cashFlow.income / cashFlow.expenses) * 100)
    : 0;
  const overspentPercent = cashFlow.expenses > 0
    ? Math.min(100, (overspentAmount / cashFlow.expenses) * 100)
    : 0;
  const dreamTargetTotalPercent = Object.values(dreamBudget.categoryPercents)
    .reduce((sum, value) => sum + (Number(value) || 0), 0);

  const handleGlobalBudgetChange = (event) => {
    const nextValue = event.target.value;
    setGlobalBudgetByPeriod(previous => ({ ...previous, [period.key]: nextValue }));
    const nextNumber = Number(nextValue);
    if (Number.isFinite(nextNumber) && nextNumber > 0) {
      window.localStorage.setItem(`easymoney:global-budget:${period.key}`, String(nextNumber));
    } else {
      window.localStorage.removeItem(`easymoney:global-budget:${period.key}`);
    }
  };

  const hydratePeriodBudget = (periodKey) => {
    setGlobalBudgetByPeriod(previous => (
      Object.prototype.hasOwnProperty.call(previous, periodKey)
        ? previous
        : { ...previous, [periodKey]: getStoredGlobalBudget(periodKey) }
    ));
  };

  const handleTargetPercentChange = async (categoryId, value) => {
    if (!isMonthlyPeriod || categoryId === 'uncategorized' || globalBudget <= 0) return;
    const nextPercent = clampPercent(Number(value));
    setSavingCategoryId(categoryId);
    try {
      await setBudget(categoryId, Math.round(((nextPercent / 100) * globalBudget) * 100) / 100);
    } finally {
      setSavingCategoryId(null);
    }
  };

  const shiftMonth = (direction) => {
    const nextMonth = toMonthKey(addMonths(parseISO(`${month}-01`), direction));
    setMonth(nextMonth);
    hydratePeriodBudget(`month:${nextMonth}`);
  };

  const shiftYear = (direction) => {
    const nextYear = String(Number(year) + direction);
    setYear(nextYear);
    hydratePeriodBudget(`year:${nextYear}`);
  };

  const resetGlobalBudget = () => {
    window.localStorage.removeItem(`easymoney:global-budget:${period.key}`);
    setGlobalBudgetByPeriod(previous => ({ ...previous, [period.key]: '' }));
  };

  const persistDreamBudget = (nextDreamBudget) => {
    const cleaned = {
      globalBudget: Number(nextDreamBudget.globalBudget) > 0 ? Number(nextDreamBudget.globalBudget) : 0,
      categoryPercents: Object.fromEntries(
        Object.entries(nextDreamBudget.categoryPercents || {})
          .map(([categoryId, value]) => [categoryId, clampPercent(Number(value))])
          .filter(([, value]) => value > 0)
      )
    };
    window.localStorage.setItem(DREAM_BUDGET_KEY, JSON.stringify(cleaned));
    setDreamBudget(cleaned);
    setDraftDreamBudget(cleaned);
    return cleaned;
  };

  const persistSavedBudgets = (nextSavedBudgets) => {
    window.localStorage.setItem(SAVED_BUDGETS_KEY, JSON.stringify(nextSavedBudgets));
    setSavedBudgets(nextSavedBudgets);
  };

  const applySavedBudget = (budgetId = selectedSavedBudgetId) => {
    const budget = savedBudgets.find(item => item.id === budgetId);
    if (!budget) return;
    const applied = persistDreamBudget({
      globalBudget: budget.globalBudget,
      categoryPercents: budget.categoryPercents
    });
    setSelectedSavedBudgetId(budget.id);
    setDraftBudgetName(budget.name);
    setDraftDreamBudget(applied);
  };

  const buildDreamFromDisplayedPeriod = () => {
    const denominator = cashFlow.income > 0 ? Math.max(cashFlow.income, cashFlow.expenses) : cashFlow.expenses;
    const monthlyDenominator = period.scale > 0 ? denominator / period.scale : denominator;
    const nextCategoryPercents = {};
    if (denominator > 0) {
      rows.forEach(row => {
        if (row.category.id === 'uncategorized' || row.actual <= 0) return;
        nextCategoryPercents[String(row.category.id)] = Math.round(((row.actual / denominator) * 100) * 10) / 10;
      });
    }

    return {
      globalBudget: monthlyDenominator,
      categoryPercents: nextCategoryPercents
    };
  };

  const getDefaultPeriodBudgetName = () => {
    if (periodMode === PERIOD_MODES.MONTH) {
      return `${format(parseISO(`${month}-01`), 'MMMM yyyy')} Budget`;
    }
    if (periodMode === PERIOD_MODES.YEAR) {
      return `${year} Budget`;
    }
    return `${period.label} Budget`;
  };

  const upsertSavedBudget = (name, nextBudget) => {
    const applied = persistDreamBudget(nextBudget);
    const existing = savedBudgets.find(item => item.name.toLowerCase() === name.toLowerCase());
    const savedBudget = {
      id: existing?.id || crypto.randomUUID(),
      name,
      globalBudget: applied.globalBudget,
      categoryPercents: applied.categoryPercents,
      updatedAt: new Date().toISOString()
    };
    const nextSavedBudgets = existing
      ? savedBudgets.map(item => item.id === existing.id ? savedBudget : item)
      : [...savedBudgets, savedBudget];
    persistSavedBudgets(nextSavedBudgets);
    setSelectedSavedBudgetId(savedBudget.id);
    setDraftBudgetName(savedBudget.name);
    return savedBudget;
  };

  const openSavePeriodBudget = () => {
    setPeriodBudgetName(getDefaultPeriodBudgetName());
    setIsSavingPeriodBudget(true);
  };

  const saveBudgetFromDisplayedPeriod = () => {
    const name = periodBudgetName.trim() || getDefaultPeriodBudgetName();
    upsertSavedBudget(name, buildDreamFromDisplayedPeriod());
    setIsSavingPeriodBudget(false);
  };

  const openDesignBudget = () => {
    setDraftDreamBudget(dreamBudget);
    const selectedBudget = savedBudgets.find(item => item.id === selectedSavedBudgetId);
    setDraftBudgetName(selectedBudget?.name || 'Budget Template');
    setIsDesigningBudget(true);
  };

  const updateDraftCategoryPercent = (categoryId, value) => {
    const nextValue = clampPercent(Number(value));
    setDraftDreamBudget(previous => ({
      ...previous,
      categoryPercents: {
        ...previous.categoryPercents,
        [String(categoryId)]: nextValue
      }
    }));
  };

  const saveDraftDreamBudget = () => {
    const applied = persistDreamBudget(draftDreamBudget);
    const name = draftBudgetName.trim() || 'Budget Template';
    const existing = savedBudgets.find(item => item.id === selectedSavedBudgetId || item.name.toLowerCase() === name.toLowerCase());
    const savedBudget = {
      id: existing?.id || crypto.randomUUID(),
      name,
      globalBudget: applied.globalBudget,
      categoryPercents: applied.categoryPercents,
      updatedAt: new Date().toISOString()
    };
    const nextSavedBudgets = existing
      ? savedBudgets.map(item => item.id === existing.id ? savedBudget : item)
      : [...savedBudgets, savedBudget];
    persistSavedBudgets(nextSavedBudgets);
    setSelectedSavedBudgetId(savedBudget.id);
    setIsDesigningBudget(false);
  };

  return (
    <>
      <div className="page budgeting-page stagger-in">
      <div className="page__header budgeting-page__header">
        <div>
          <h1 className="page__title">Budgeting</h1>
          <p className="page__subtitle">Save monthly budget templates and compare them across any period.</p>
        </div>

        <div className="budgeting-period-controls">
          <button className="btn btn--secondary" type="button" onClick={openDesignBudget}>
            <Wand2 size={16} />
            Design Budget
          </button>
          {savedBudgets.length > 0 && (
            <div className="budgeting-saved-budget">
              <select
                className="input input--sm"
                value={selectedSavedBudgetId}
                onChange={(event) => setSelectedSavedBudgetId(event.target.value)}
                aria-label="Saved budgets"
              >
                <option value="">Saved budgets</option>
                {savedBudgets.map(budget => (
                  <option key={budget.id} value={budget.id}>{budget.name}</option>
                ))}
              </select>
              <button
                className="btn btn--secondary btn--sm"
                type="button"
                disabled={!selectedSavedBudgetId}
                onClick={() => applySavedBudget()}
              >
                Apply
              </button>
            </div>
          )}
          <div className="budgeting-period-tabs" aria-label="Budget period">
            {Object.values(PERIOD_MODES).map(mode => (
              <button
                key={mode}
                className={periodMode === mode ? 'active' : ''}
                type="button"
                onClick={() => {
                  setPeriodMode(mode);
                  const nextKey = mode === PERIOD_MODES.YEAR
                    ? `year:${year}`
                    : mode === PERIOD_MODES.CUSTOM
                      ? `custom:${customStartDate}:${customEndDate}`
                      : `month:${month}`;
                  hydratePeriodBudget(nextKey);
                }}
              >
                {mode}
              </button>
            ))}
          </div>

          {periodMode === PERIOD_MODES.MONTH && (
            <div className="budgeting-controls">
              <button className="btn btn--ghost btn--icon" type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month">
                <ArrowDown size={16} />
              </button>
              <label className="budgeting-month">
                <Calendar size={15} />
                <input
                  className="input input--sm"
                  type="month"
                  value={month}
                  onChange={(event) => {
                    setMonth(event.target.value);
                    hydratePeriodBudget(`month:${event.target.value}`);
                  }}
                />
              </label>
              <button className="btn btn--ghost btn--icon" type="button" onClick={() => shiftMonth(1)} aria-label="Next month">
                <ArrowUp size={16} />
              </button>
            </div>
          )}

          {periodMode === PERIOD_MODES.YEAR && (
            <div className="budgeting-controls">
              <button className="btn btn--ghost btn--icon" type="button" onClick={() => shiftYear(-1)} aria-label="Previous year">
                <ArrowDown size={16} />
              </button>
              <label className="budgeting-month">
                <Calendar size={15} />
                <input
                  className="input input--sm"
                  type="number"
                  min="2000"
                  max="2100"
                  value={year}
                  onChange={(event) => {
                    setYear(event.target.value);
                    hydratePeriodBudget(`year:${event.target.value}`);
                  }}
                />
              </label>
              <button className="btn btn--ghost btn--icon" type="button" onClick={() => shiftYear(1)} aria-label="Next year">
                <ArrowUp size={16} />
              </button>
            </div>
          )}

          {periodMode === PERIOD_MODES.CUSTOM && (
            <div className="budgeting-custom-range">
              <label>
                <Calendar size={15} />
                <input
                  className="input input--sm"
                  type="date"
                  value={customStartDate}
                  onChange={(event) => {
                    setCustomStartDate(event.target.value);
                    hydratePeriodBudget(`custom:${event.target.value}:${customEndDate}`);
                  }}
                />
              </label>
              <span>to</span>
              <input
                className="input input--sm"
                type="date"
                value={customEndDate}
                onChange={(event) => {
                  setCustomEndDate(event.target.value);
                  hydratePeriodBudget(`custom:${customStartDate}:${event.target.value}`);
                }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="budgeting-summary grid-4">
        <div className="glass-card kpi-card">
          <div className="kpi-card__label">Period Budget</div>
          <div className="budgeting-baseline">
            <span>$</span>
            <input
              className="input"
              type="number"
              min="0"
              step="50"
              value={globalBudgetInput}
              onChange={handleGlobalBudgetChange}
              placeholder={autoGlobalBudget ? String(Math.round(autoGlobalBudget)) : '0'}
              aria-label="Budget for selected period"
            />
            <button className="btn btn--ghost btn--icon btn--sm" type="button" onClick={resetGlobalBudget} aria-label="Use automatic budget">
              <RotateCcw size={14} />
            </button>
          </div>
          <div className="kpi-card__detail">{dreamBudget.globalBudget > 0 && !globalBudgetInput ? `Saved budget - ${period.label}` : period.label}</div>
        </div>
        <div className="glass-card kpi-card">
          <div className="kpi-card__label">Actual Spending</div>
          <div className="kpi-card__value">{formatCurrency(cashFlow.expenses)}</div>
          <div className="kpi-card__detail">{formatPercentValue(actualSpendPercent)} of period budget</div>
        </div>
        <div className="glass-card kpi-card">
          <div className="kpi-card__label">Remaining</div>
          <div className={`kpi-card__value ${budgetRemaining >= 0 ? 'amount--positive' : 'amount--negative'}`}>
            {formatCurrency(budgetRemaining, true)}
          </div>
          <div className="kpi-card__detail">{budgetRemaining >= 0 ? 'under budget' : 'over budget'}</div>
        </div>
        <div className="glass-card kpi-card">
          <div className="kpi-card__label">Income</div>
          <div className="kpi-card__value amount--positive">{formatCurrency(cashFlow.income)}</div>
          <div className="kpi-card__detail">
            {cashFlow.income > cashFlow.expenses
              ? `${formatCurrency(unspentIncome)} unspent`
              : overspentAmount > 0
                ? `${formatCurrency(overspentAmount)} beyond income`
                : 'matches spending'}
          </div>
        </div>
      </div>

      <div className="budgeting-grid">
        <section className="glass-card budgeting-allocation-panel">
          <div className="budgeting-section-heading">
            <div>
              <h2>Income Allocation</h2>
              <p>How this period's inflow was spent, with unspent income shown when available.</p>
            </div>
            <button className="btn btn--secondary btn--sm" type="button" onClick={openSavePeriodBudget}>
              <Wand2 size={14} />
              Save Budget from This Period
            </button>
          </div>

          <div className="budgeting-allocation">
            <div className="budgeting-chart">
              {allocationData.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={allocationData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius="62%"
                        outerRadius="86%"
                        paddingAngle={2}
                      >
                        {allocationData.map(item => (
                          <Cell key={item.name} fill={item.color} />
                        ))}
                      </Pie>
                      <Tooltip content={<BudgetTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="budgeting-chart__center">
                    <span>{cashFlow.income > 0 ? 'Income' : 'Spent'}</span>
                    <strong>{formatCurrency(cashFlow.income > 0 ? Math.max(cashFlow.income, cashFlow.expenses) : cashFlow.expenses)}</strong>
                  </div>
                </>
              ) : (
                <div className="empty-state-simple">No spending or income for this period.</div>
              )}
            </div>

            <div className="budgeting-legend">
              {allocationData.map(item => (
                <div key={item.name} className="budgeting-legend__row">
                  <span className="budgeting-legend__dot" style={{ background: item.color }} />
                  <span>{item.name}</span>
                  <strong>{formatPercentValue(allocationTotal > 0 ? (item.value / allocationTotal) * 100 : 0)}</strong>
                </div>
              ))}

              {overspentAmount > 0 && (
                <div className="budgeting-overflow-card">
                  <div className="budgeting-overflow-card__header">
                    <span>Income coverage</span>
                    <strong>{formatCurrency(overspentAmount)} over</strong>
                  </div>
                  <div className="budgeting-overflow-bar" aria-label="Income coverage compared to overspent amount">
                    <span
                      className="budgeting-overflow-bar__income"
                      style={{ width: `${incomeCoveragePercent}%` }}
                    />
                    <span
                      className="budgeting-overflow-bar__over"
                      style={{ width: `${overspentPercent}%` }}
                    />
                  </div>
                  <div className="budgeting-overflow-card__legend">
                    <span>Covered by income: {formatCurrency(Math.min(cashFlow.income, cashFlow.expenses))}</span>
                    <span>Beyond income: {formatCurrency(overspentAmount)}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="glass-card budgeting-allocator">
          <div className="budgeting-section-heading">
            <div>
              <h2>{isMonthlyPeriod ? 'Monthly Category Targets' : 'Category Breakdown'}</h2>
              <p>{hasDreamTargets ? 'Comparing this period against the applied saved budget.' : isMonthlyPeriod ? 'Adjust target percentages for each expense category.' : 'Category targets are editable in monthly views.'}</p>
            </div>
            <div className={`budgeting-target-total ${targetTotalPercent > 100 ? 'budgeting-target-total--over' : ''}`}>
              <Target size={16} />
              <span>{hasDreamTargets ? `${formatPercentValue(dreamTargetTotalPercent)} saved` : isMonthlyPeriod ? `${formatPercentValue(targetTotalPercent)} assigned` : 'read-only'}</span>
            </div>
          </div>

          <div className="budgeting-table">
            <div className="budgeting-table__head">
              <span>Category</span>
              <span>Target</span>
              <span>Actual</span>
              <span>Gap</span>
              <span>Status</span>
            </div>
            {rows.map(row => (
              <div className="budgeting-row" key={row.category.id}>
                <div className="budgeting-category">
                  <span className="budgeting-category__dot" style={{ backgroundColor: row.category.color || '#94a3b8' }} />
                  <div>
                    <strong>{row.category.name}</strong>
                    <span>{formatCurrency(row.budgetAmount)} target</span>
                  </div>
                </div>
                <div className="budgeting-target-control">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(row.targetPercent)}
                    disabled={hasDreamTargets || !isMonthlyPeriod || row.category.id === 'uncategorized' || globalBudget <= 0}
                    onChange={(event) => handleTargetPercentChange(row.category.id, event.target.value)}
                    aria-label={`${row.category.name} target percentage`}
                  />
                  <div className="budgeting-percent-input">
                    <input
                      className="input input--sm"
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={Math.round(row.targetPercent)}
                      disabled={hasDreamTargets || !isMonthlyPeriod || row.category.id === 'uncategorized' || globalBudget <= 0}
                      onChange={(event) => handleTargetPercentChange(row.category.id, event.target.value)}
                      aria-label={`${row.category.name} target percentage number`}
                    />
                    <span>%</span>
                  </div>
                </div>
                <div className="budgeting-actual">
                  <strong>{formatCurrency(row.actual)}</strong>
                  <span>{formatPercentValue(row.actualPercent)}</span>
                </div>
                <div className={row.variance > 0 ? 'amount amount--negative' : 'amount amount--positive'}>
                  {row.budgetAmount > 0 ? formatCurrency(Math.abs(row.variance)) : formatCurrency(row.actual)}
                </div>
                <div>
                  <span className={`budgeting-status budgeting-status--${row.status}`}>
                    {row.status === 'aligned' ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
                    {savingCategoryId === row.category.id ? 'Saving' : row.status}
                  </span>
                </div>
              </div>
            ))}
            {rows.length === 0 && (
              <div className="empty-state-simple">No expense categories or transactions for this month.</div>
            )}
          </div>
        </section>

        <aside className="budgeting-insights">
          <section className="glass-card budgeting-card">
            <div className="budgeting-card__icon budgeting-card__icon--green">
              <PiggyBank size={18} />
            </div>
            <h2>Alignment</h2>
            <p>
              You have {formatCurrency(Math.max(0, budgetRemaining))} left against the current period budget.
            </p>
            <div className="budgeting-meter">
              <span style={{ width: `${Math.min(100, actualSpendPercent)}%` }} />
            </div>
          </section>

          <section className="glass-card budgeting-card">
            <h2>Over Target</h2>
            <div className="budgeting-insight-list">
              {overRows.slice(0, 5).map(row => (
                <div className="budgeting-insight-row" key={row.category.id}>
                  <span>{row.category.name}</span>
                  <strong>{formatPercentValue(row.percentGap)} over</strong>
                </div>
              ))}
              {overRows.length === 0 && <p className="budgeting-muted">No categories are over their target.</p>}
            </div>
          </section>

          <section className="glass-card budgeting-card">
            <h2>Unplanned Spend</h2>
            <div className="budgeting-insight-list">
              {unplannedRows.slice(0, 5).map(row => (
                <div className="budgeting-insight-row" key={row.category.id}>
                  <span>{row.category.name}</span>
                  <strong>{formatCurrency(row.actual)}</strong>
                </div>
              ))}
              {unplannedRows.length === 0 && <p className="budgeting-muted">Every spending category has a target.</p>}
            </div>
          </section>
        </aside>
      </div>
      </div>

      <Modal
        isOpen={isDesigningBudget}
        onClose={() => setIsDesigningBudget(false)}
        title="Design Budget"
        maxWidth="780px"
        footer={(
          <>
            <button className="btn btn--ghost" type="button" onClick={() => setIsDesigningBudget(false)}>
              Cancel
            </button>
            <button className="btn btn--secondary" type="button" onClick={() => setDraftDreamBudget(buildDreamFromDisplayedPeriod())}>
              <Wand2 size={15} />
              Use This Period
            </button>
            <button className="btn btn--primary" type="button" onClick={saveDraftDreamBudget}>
              Save and Apply Budget
            </button>
          </>
        )}
      >
        <div className="budgeting-design-modal">
          <div className="budgeting-design-summary">
            <label className="form-group">
              <span className="form-label">Budget name</span>
              <input
                className="input"
                value={draftBudgetName}
                onChange={(event) => setDraftBudgetName(event.target.value)}
                placeholder="Budget Template"
              />
            </label>
            <label className="form-group">
              <span className="form-label">Monthly budget amount</span>
              <input
                className="input"
                type="number"
                min="0"
                step="50"
                value={draftDreamBudget.globalBudget || ''}
                onChange={(event) => setDraftDreamBudget(previous => ({
                  ...previous,
                  globalBudget: Number(event.target.value) || 0
                }))}
                placeholder={autoGlobalBudget ? String(Math.round(autoGlobalBudget)) : '0'}
              />
            </label>
            <div className="budgeting-design-total">
              <span>Category targets</span>
              <strong>{formatPercentValue(Object.values(draftDreamBudget.categoryPercents).reduce((sum, value) => sum + (Number(value) || 0), 0))}</strong>
            </div>
          </div>

          <div className="budgeting-design-list">
            {expenseCategories.map(category => {
              const value = Number(draftDreamBudget.categoryPercents[String(category.id)]) || 0;
              return (
                <div className="budgeting-design-row" key={category.id}>
                  <div className="budgeting-category">
                    <span className="budgeting-category__dot" style={{ backgroundColor: category.color || '#94a3b8' }} />
                    <div>
                      <strong>{category.name}</strong>
                      <span>{formatCurrency(((draftDreamBudget.globalBudget || globalBudget) * value) / 100)} target</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(value)}
                    onChange={(event) => updateDraftCategoryPercent(category.id, event.target.value)}
                    aria-label={`${category.name} budget percentage`}
                  />
                  <div className="budgeting-percent-input">
                    <input
                      className="input input--sm"
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={Math.round(value)}
                      onChange={(event) => updateDraftCategoryPercent(category.id, event.target.value)}
                      aria-label={`${category.name} budget percentage number`}
                    />
                    <span>%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isSavingPeriodBudget}
        onClose={() => setIsSavingPeriodBudget(false)}
        title="Save Budget from This Period"
        maxWidth="520px"
        footer={(
          <>
            <button className="btn btn--ghost" type="button" onClick={() => setIsSavingPeriodBudget(false)}>
              Cancel
            </button>
            <button className="btn btn--primary" type="button" onClick={saveBudgetFromDisplayedPeriod}>
              Save and Apply Budget
            </button>
          </>
        )}
      >
        <div className="budgeting-save-period-modal">
          <p className="budgeting-muted">
            This will save the current period's allocation as a monthly budget template and apply it immediately.
          </p>
          <label className="form-group">
            <span className="form-label">Budget name</span>
            <input
              className="input"
              value={periodBudgetName}
              onChange={(event) => setPeriodBudgetName(event.target.value)}
              placeholder={getDefaultPeriodBudgetName()}
              autoFocus
            />
          </label>
          <div className="budgeting-save-period-summary">
            <span>Monthly budget amount</span>
            <strong>{formatCurrency(buildDreamFromDisplayedPeriod().globalBudget)}</strong>
          </div>
        </div>
      </Modal>
    </>
  );
}
