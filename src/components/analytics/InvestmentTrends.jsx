import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { isInvestmentMovement } from '../../utils/transactionSemantics';

const formatCurrency = (val) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
}).format(val);

const resolveGrouping = (transactions, groupMode) => {
  if (groupMode === 'Monthly') return { labelFormat: 'MMM yyyy', keyFormat: 'yyyy-MM' };
  if (groupMode === 'Yearly') return { labelFormat: 'yyyy', keyFormat: 'yyyy' };

  const dates = transactions.map(t => new Date(t.date).getTime());
  const diffDays = (Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24);
  return diffDays > 60
    ? { labelFormat: 'MMM yyyy', keyFormat: 'yyyy-MM' }
    : { labelFormat: 'MMM dd', keyFormat: 'yyyy-MM-dd' };
};

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

export default function InvestmentTrends({ transactions, accountMap = {}, categoryMap = {}, groupMode = 'Auto', onSelectPeriod }) {
  const data = useMemo(() => {
    const investmentTransactions = transactions.filter(t => isInvestmentMovement(t, accountMap, categoryMap));
    if (investmentTransactions.length === 0) return [];

    const { labelFormat, keyFormat } = resolveGrouping(investmentTransactions, groupMode);
    const grouped = {};

    investmentTransactions.forEach(t => {
      const dateObj = parseISO(t.date);
      const groupKey = format(dateObj, keyFormat);
      const displayLabel = format(dateObj, labelFormat);

      if (!grouped[groupKey]) {
        grouped[groupKey] = { timeKey: groupKey, displayLabel, Investments: 0, transactionIds: [] };
      }

      grouped[groupKey].Investments += Math.abs(t.amount);
      grouped[groupKey].transactionIds.push(t.id);
    });

    return Object.values(grouped).sort((a, b) => a.timeKey.localeCompare(b.timeKey));
  }, [transactions, accountMap, categoryMap, groupMode]);

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
          margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
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
            dx={-10}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(245, 158, 11, 0.08)' }} />
          <Bar dataKey="Investments" fill="#f59e0b" radius={[4, 4, 0, 0]} maxBarSize={44} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
