import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import PeriodClickOverlay from './PeriodClickOverlay';

const COLORS = [
  '#f97316', '#22c55e', '#6366f1', '#3b82f6', '#ec4899', 
  '#ef4444', '#a855f7', '#eab308', '#14b8a6', '#06b6d4'
];
const TOTAL_SPEND_KEY = 'Total Spend';
const TOTAL_SPEND_COLOR = '#f8fafc';

const formatCurrency = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);

const CustomTooltip = ({ active, payload, showTotalSpend }) => {
  if (active && payload && payload.length) {
    const totalPayload = payload.find(p => p.dataKey === TOTAL_SPEND_KEY);
    const activePayloads = payload
      .filter(p => p.value > 0 && p.dataKey !== TOTAL_SPEND_KEY)
      .sort((a, b) => b.value - a.value);

    return (
      <div className="custom-tooltip">
        <div className="label">{payload[0].payload.displayLabel}</div>
        {showTotalSpend && totalPayload && (
          <div className="value-row" style={{ color: totalPayload.color }}>
            <span>Total Spend:</span>
            <span className="amount amount--negative">{formatCurrency(totalPayload.value)}</span>
          </div>
        )}
        {activePayloads.map((entry, index) => (
          <div key={index} className="value-row" style={{ color: entry.color }}>
            <span>{entry.name}:</span>
            <span className="amount amount--negative">{formatCurrency(entry.value)}</span>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

export default function SpendingTrends({
  rows = [],
  showTotalSpend = true,
  onSelectPeriod
}) {
  const activeCategories = Array.from(new Set(rows.flatMap(row => Object.keys(row.categoryAmounts ?? {}))));
  const data = rows.map(row => {
    const item = {
      ...row,
      timeKey: row.key,
      displayLabel: row.label,
      [TOTAL_SPEND_KEY]: row.expenses,
    };
    activeCategories.forEach(category => {
      item[category] = row.categoryAmounts?.[category] ?? 0;
    });
    return item;
  });

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
        <LineChart
          data={data}
          margin={{ top: 10, right: 18, left: 12, bottom: 0 }}
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
          <Tooltip content={<CustomTooltip showTotalSpend={showTotalSpend} />} />
          <Legend
            verticalAlign="top"
            align="left"
            iconType="plainline"
            wrapperStyle={{ color: 'var(--text-secondary)', fontSize: '12px', paddingBottom: '8px' }}
          />
          {showTotalSpend && (
            <Line
              key={TOTAL_SPEND_KEY}
              type="monotone"
              dataKey={TOTAL_SPEND_KEY}
              name="Total Spend"
              stroke={TOTAL_SPEND_COLOR}
              strokeWidth={3}
              dot={false}
              activeDot={{ r: 5, strokeWidth: 0 }}
            />
          )}
          {activeCategories.map((cat, index) => (
            <Line
              key={cat}
              type="monotone"
              dataKey={cat}
              stroke={COLORS[index % COLORS.length]}
              strokeWidth={1.8}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          ))}
          <PeriodClickOverlay data={data} onSelectPeriod={onSelectPeriod} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
