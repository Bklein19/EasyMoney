import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from 'recharts';
import { useTransactions } from '../../hooks/useTransactions';
import { useAccounts } from '../../hooks/useAccounts';
import { useCategories } from '../../hooks/useCategories';
import { formatCurrency, formatMonthKey } from '../../utils/formatters';
import { buildAccountMap, isExpense, isIncome } from '../../utils/transactionSemantics';

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="custom-tooltip">
        <div className="custom-tooltip__label">{label}</div>
        {payload.map((entry, index) => (
          <p key={`item-${index}`} className="custom-tooltip__item">
            <span className="custom-tooltip__dot" style={{ backgroundColor: entry.color }} />
            {`${entry.name}: ${formatCurrency(entry.value)}`}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

export default function MonthlyTrendChart() {
  const { transactions } = useTransactions();
  const { accounts } = useAccounts();
  const { categories } = useCategories();
  const accountMap = useMemo(() => buildAccountMap(accounts), [accounts]);
  const categoryMap = useMemo(() => {
    const map = {};
    categories.forEach(c => { map[c.id] = c; });
    return map;
  }, [categories]);

  const data = useMemo(() => {
    const months = {};
    
    // Process last 6 months
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      months[monthKey] = { name: formatMonthKey(monthKey), income: 0, expense: 0, sortKey: monthKey };
    }

    transactions.forEach(t => {
      const monthKey = t.date.substring(0, 7); // YYYY-MM
      if (months[monthKey]) {
        if (isIncome(t, accountMap, categoryMap)) {
          months[monthKey].income += t.amount;
        } else if (isExpense(t, accountMap, categoryMap)) {
          months[monthKey].expense += Math.abs(t.amount);
        }
      }
    });

    return Object.values(months).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }, [transactions, accountMap, categoryMap]);

  return (
    <div className="glass-card dashboard-main-chart">
      <div className="dashboard-card-header">
        <h3 className="dashboard-card-title">Income & Expenses</h3>
      </div>
      <div className="dashboard-card-content">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 20, right: 0, left: -20, bottom: 0 }} barGap={4}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(val) => `$${val/1000}k`} axisLine={false} tickLine={false} />
            <RechartsTooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
            <Legend verticalAlign="top" height={36} iconType="circle" />
            <Bar dataKey="income" name="Income" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={40} />
            <Bar dataKey="expense" name="Expense" fill="#ef4444" radius={[4, 4, 0, 0]} maxBarSize={40} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
