// @ts-nocheck
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';

const formatCurrency = (val) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
}).format(val);

const CustomTooltip = ({ active, payload }) => {
  if (active && payload && payload.length) {
    return (
      <div className="custom-tooltip">
        <div className="label">{payload[0].payload.displayLabel}</div>
        <div className="value-row">
          <span style={{ color: payload[0].color }}>Investments:</span>
          <span className="amount amount--neutral">{formatCurrency(payload[0].value)}</span>
        </div>
      </div>
    );
  }
  return null;
};

export default function InvestmentTrends({ rows = [], onSelectPeriod }) {
  const data = rows.map(row => ({
    ...row,
    timeKey: row.key,
    displayLabel: row.label,
    Investments: row.amount,
  }));

  if (data.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">$</div>
        <p className="empty-state__description">No investment transfers to display for this period.</p>
      </div>
    );
  }

  return (
    <div className="chart-container">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 10, right: 10, left: 12, bottom: 0 }}
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
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(245, 158, 11, 0.08)' }} />
          <Bar dataKey="Investments" fill="#f59e0b" radius={[4, 4, 0, 0]} maxBarSize={44} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
