import { useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import { endOfDay, endOfMonth, endOfWeek, endOfYear, format, parseISO, startOfDay, startOfMonth, startOfWeek, startOfYear } from 'date-fns';
import { isExpense } from '../../utils/transactionSemantics';
import PeriodClickOverlay from './PeriodClickOverlay';

const COLORS = [
  '#f97316', '#22c55e', '#6366f1', '#3b82f6', '#ec4899', 
  '#ef4444', '#a855f7', '#eab308', '#14b8a6', '#06b6d4'
];

const formatCurrency = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);

const resolveGrouping = (transactions, groupMode) => {
  if (groupMode === 'Daily') return { labelFormat: 'MMM d', keyFormat: 'yyyy-MM-dd' };
  if (groupMode === 'Weekly') return { labelFormat: 'week', keyFormat: 'week' };
  if (groupMode === 'Monthly') return { labelFormat: 'MMM yyyy', keyFormat: 'yyyy-MM' };
  if (groupMode === 'Yearly') return { labelFormat: 'yyyy', keyFormat: 'yyyy' };

  const dates = transactions.map(t => new Date(t.date).getTime());
  const diffDays = (Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24);
  return diffDays > 400
    ? { labelFormat: 'yyyy', keyFormat: 'yyyy' }
    : diffDays > 60
    ? { labelFormat: 'MMM yyyy', keyFormat: 'yyyy-MM' }
    : { labelFormat: 'week', keyFormat: 'week' };
};

const CustomTooltip = ({ active, payload }) => {
  if (active && payload && payload.length) {
    const activePayloads = payload.filter(p => p.value > 0).sort((a, b) => b.value - a.value);
    const total = activePayloads.reduce((sum, p) => sum + p.value, 0);

    return (
      <div className="custom-tooltip">
        <div className="label">{payload[0].payload.displayLabel}</div>
        {activePayloads.map((entry, index) => (
          <div key={index} className="value-row" style={{ color: entry.color }}>
            <span>{entry.name}:</span>
            <span className="amount amount--negative">{formatCurrency(entry.value)}</span>
          </div>
        ))}
        <div className="value-row" style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--glass-border)' }}>
          <span>Total:</span>
          <span className="amount">{formatCurrency(total)}</span>
        </div>
      </div>
    );
  }
  return null;
};

export default function SpendingTrends({ transactions, categoryMap, accountMap = {}, groupMode = 'Auto', onSelectPeriod }) {
  const { data, activeCategories } = useMemo(() => {
    if (transactions.length === 0) return { data: [], activeCategories: [] };

    const { labelFormat, keyFormat } = resolveGrouping(transactions, groupMode);

    const grouped = {};
    const catSet = new Set();

    transactions.forEach(t => {
      if (isExpense(t, accountMap, categoryMap)) {
        const dateObj = parseISO(t.date);
        const weekStart = startOfWeek(dateObj);
        const groupKey = keyFormat === 'week' ? format(weekStart, 'yyyy-MM-dd') : format(dateObj, keyFormat);
        const displayLabel = keyFormat === 'week' ? `Week of ${format(weekStart, 'MMM d')}` : format(dateObj, labelFormat);
        const periodStart = keyFormat === 'yyyy'
          ? startOfYear(dateObj)
          : keyFormat === 'yyyy-MM'
            ? startOfMonth(dateObj)
            : keyFormat === 'week'
              ? weekStart
            : startOfDay(dateObj);
        const periodEnd = keyFormat === 'yyyy'
          ? endOfYear(dateObj)
          : keyFormat === 'yyyy-MM'
            ? endOfMonth(dateObj)
            : keyFormat === 'week'
              ? endOfWeek(dateObj)
            : endOfDay(dateObj);
        const catId = t.categoryId || 'uncategorized';
        const catName = categoryMap[catId] ? categoryMap[catId].name : 'Uncategorized';
        
        if (!grouped[groupKey]) {
          grouped[groupKey] = {
            timeKey: groupKey,
            displayLabel,
            startDate: format(periodStart, 'yyyy-MM-dd'),
            endDate: format(periodEnd, 'yyyy-MM-dd'),
            transactionIds: []
          };
        }
        
        grouped[groupKey][catName] = (grouped[groupKey][catName] || 0) + Math.abs(t.amount);
        grouped[groupKey].transactionIds.push(t.id);
        catSet.add(catName);
      }
    });

    const sortedData = Object.values(grouped).sort((a, b) => a.timeKey.localeCompare(b.timeKey));
    
    // Fill in missing 0s for stacked area to render correctly
    sortedData.forEach(d => {
      catSet.forEach(cat => {
        if (d[cat] === undefined) d[cat] = 0;
      });
    });

    return { 
      data: sortedData, 
      activeCategories: Array.from(catSet) 
    };
  }, [transactions, categoryMap, accountMap, groupMode]);

  if (data.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">📈</div>
        <p className="empty-state__description">No expense data to display for this period.</p>
      </div>
    );
  }

  return (
    <div className="chart-container">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 10, right: 10, left: 12, bottom: 0 }}
          style={{ cursor: 'pointer' }}
          onClick={(state) => {
            if (state?.activePayload?.[0]?.payload && onSelectPeriod) {
              onSelectPeriod(state.activePayload[0].payload);
            }
          }}
        >
          <defs>
            {activeCategories.map((cat, index) => (
              <linearGradient key={`color-${cat}`} id={`color-${cat}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={COLORS[index % COLORS.length]} stopOpacity={0.8}/>
                <stop offset="95%" stopColor={COLORS[index % COLORS.length]} stopOpacity={0.1}/>
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148, 163, 184, 0.1)" />
          <XAxis 
            dataKey="displayLabel" 
            stroke="#94a3b8" 
            fontSize={12}
            tickLine={false}
            axisLine={false}
            dy={10}
          />
          <YAxis 
            tickFormatter={formatCurrency}
            stroke="#94a3b8"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            width={72}
          />
          <Tooltip content={<CustomTooltip />} />
          {activeCategories.map((cat, index) => (
            <Area
              key={cat}
              type="monotone"
              dataKey={cat}
              stackId="1"
              stroke={COLORS[index % COLORS.length]}
              fill={`url(#color-${cat})`}
              strokeWidth={2}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          ))}
          <PeriodClickOverlay data={data} onSelectPeriod={onSelectPeriod} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
