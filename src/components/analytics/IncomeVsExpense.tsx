// @ts-nocheck
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
import PeriodClickOverlay from './PeriodClickOverlay';

const formatCurrency = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);

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

export default function IncomeVsExpense({ rows = [], onSelectPeriod }) {
  const data = rows.map(row => ({
    ...row,
    timeKey: row.key,
    displayLabel: row.label,
    Income: row.income,
    Expense: row.expenses,
  }));

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
