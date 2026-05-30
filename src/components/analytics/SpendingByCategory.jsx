import { useMemo } from 'react';
import { isExpense } from '../../utils/transactionSemantics';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell
} from 'recharts';

// A palette of nice colors from index.css for categories if they don't have a specific color
const COLORS = [
  '#f97316', '#22c55e', '#6366f1', '#3b82f6', '#ec4899', 
  '#ef4444', '#a855f7', '#eab308', '#14b8a6', '#06b6d4'
];

const formatCurrency = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);

const CustomTooltip = ({ active, payload }) => {
  if (active && payload && payload.length) {
    return (
      <div className="custom-tooltip">
        <div className="label">{payload[0].payload.name}</div>
        <div className="value-row">
          <span>Spent:</span>
          <span className="amount amount--negative">{formatCurrency(payload[0].value)}</span>
        </div>
      </div>
    );
  }
  return null;
};

export default function SpendingByCategory({ transactions, categoryMap, accountMap = {}, onSelectCategory }) {
  const data = useMemo(() => {
    const expensesMap = {};
    
    transactions.forEach(t => {
      if (isExpense(t, accountMap, categoryMap)) {
        const catId = t.categoryId || 'uncategorized';
        expensesMap[catId] = (expensesMap[catId] || 0) + Math.abs(t.amount);
      }
    });

    return Object.entries(expensesMap)
      .map(([catId, amount]) => {
        const cat = categoryMap[catId];
        return {
          id: catId,
          name: cat ? cat.name : 'Uncategorized',
          amount,
        };
      })
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10); // Top 10 categories
  }, [transactions, categoryMap, accountMap]);

  if (data.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">📊</div>
        <p className="empty-state__description">No spending data to display for this period.</p>
      </div>
    );
  }

  return (
    <div className="chart-container">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 5, right: 30, left: 28, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(148, 163, 184, 0.1)" />
          <XAxis 
            type="number" 
            tickFormatter={formatCurrency}
            stroke="#94a3b8"
            fontSize={12}
            tickLine={false}
            axisLine={false}
          />
          <YAxis 
            dataKey="name" 
            type="category" 
            width={100}
            stroke="#94a3b8"
            fontSize={12}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(148, 163, 184, 0.05)' }} />
          <Bar dataKey="amount" radius={[0, 4, 4, 0]} maxBarSize={32}>
            {data.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={COLORS[index % COLORS.length]}
                cursor={onSelectCategory ? 'pointer' : 'default'}
                onClick={() => onSelectCategory?.(entry)}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
