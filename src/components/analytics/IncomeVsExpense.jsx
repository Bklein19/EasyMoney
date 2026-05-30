import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts';
import { endOfDay, endOfMonth, endOfWeek, endOfYear, format, parseISO, startOfDay, startOfMonth, startOfWeek, startOfYear } from 'date-fns';
import { isExpense, isIncome } from '../../utils/transactionSemantics';
import PeriodClickOverlay from './PeriodClickOverlay';

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
    return (
      <div className="custom-tooltip">
        <div className="label">{payload[0].payload.displayLabel}</div>
        {payload.map((entry, index) => (
          <div key={index} className="value-row">
            <span style={{ color: entry.color }}>{entry.name}:</span>
            <span className={`amount ${entry.name === 'Income' ? 'amount--positive' : 'amount--negative'}`}>
              {formatCurrency(entry.value)}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

export default function IncomeVsExpense({ transactions, groupMode = 'Auto', accountMap = {}, categoryMap = {}, onSelectPeriod }) {
  const data = useMemo(() => {
    if (transactions.length === 0) return [];

    const { labelFormat, keyFormat } = resolveGrouping(transactions, groupMode);

    const grouped = {};

    transactions.forEach(t => {
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
      
      if (!grouped[groupKey]) {
        grouped[groupKey] = {
          timeKey: groupKey,
          displayLabel,
          startDate: format(periodStart, 'yyyy-MM-dd'),
          endDate: format(periodEnd, 'yyyy-MM-dd'),
          Income: 0,
          Expense: 0,
          transactionIds: []
        };
      }

      grouped[groupKey].transactionIds.push(t.id);
      
      if (isIncome(t, accountMap, categoryMap)) {
        grouped[groupKey].Income += t.amount;
      } else if (isExpense(t, accountMap, categoryMap)) {
        grouped[groupKey].Expense += Math.abs(t.amount);
      }
    });

    return Object.values(grouped).sort((a, b) => a.timeKey.localeCompare(b.timeKey));
  }, [transactions, groupMode, accountMap, categoryMap]);

  if (data.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">⚖️</div>
        <p className="empty-state__description">No data to display for this period.</p>
      </div>
    );
  }

  return (
    <div className="chart-container">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 10, right: 10, left: 12, bottom: 0 }}
          style={{ cursor: 'pointer' }}
          onClick={(state) => {
            if (state?.activePayload?.[0]?.payload && onSelectPeriod) {
              onSelectPeriod(state.activePayload[0].payload);
            }
          }}
        >
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
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(148, 163, 184, 0.05)' }} />
          <Legend 
            wrapperStyle={{ paddingTop: '20px', fontSize: '12px', color: 'var(--text-secondary)' }}
            iconType="circle"
          />
          <Bar
            dataKey="Income"
            fill="#10b981"
            radius={[4, 4, 0, 0]}
            maxBarSize={40}
            cursor="pointer"
            onClick={(entry) => onSelectPeriod?.(entry.payload)}
          />
          <Bar
            dataKey="Expense"
            fill="#ef4444"
            radius={[4, 4, 0, 0]}
            maxBarSize={40}
            cursor="pointer"
            onClick={(entry) => onSelectPeriod?.(entry.payload)}
          />
          <PeriodClickOverlay data={data} onSelectPeriod={onSelectPeriod} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
