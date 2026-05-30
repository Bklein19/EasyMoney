import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip, Legend } from 'recharts';
import { useTransactions } from '../../hooks/useTransactions';
import { useCategories } from '../../hooks/useCategories';
import { useAccounts } from '../../hooks/useAccounts';
import { formatCurrency } from '../../utils/formatters';
import { buildAccountMap, isExpense } from '../../utils/transactionSemantics';

const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', '#f59e0b', '#10b981', '#06b6d4', '#6366f1'];

const CustomTooltip = ({ active, payload }) => {
  if (active && payload && payload.length) {
    return (
      <div className="custom-tooltip">
        <p className="custom-tooltip__item">
          <span className="custom-tooltip__dot" style={{ backgroundColor: payload[0].payload.fill }} />
          {`${payload[0].name}: ${formatCurrency(payload[0].value)}`}
        </p>
      </div>
    );
  }
  return null;
};

export default function SpendingDonut() {
  const { transactions } = useTransactions();
  const { categories } = useCategories();
  const { accounts } = useAccounts();
  const accountMap = useMemo(() => buildAccountMap(accounts), [accounts]);
  const categoryMap = useMemo(() => {
    const map = {};
    categories.forEach(c => { map[c.id] = c; });
    return map;
  }, [categories]);

  const data = useMemo(() => {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    const expenses = transactions.filter(t =>
      isExpense(t, accountMap, categoryMap) && t.date.startsWith(currentMonth)
    );
    
    const categoryTotals = {};
    expenses.forEach(t => {
      const cat = categories.find(c => c.id === t.categoryId);
      const catName = cat ? cat.name : 'Uncategorized';
      categoryTotals[catName] = (categoryTotals[catName] || 0) + Math.abs(t.amount);
    });
    
    return Object.entries(categoryTotals)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5); // top 5
  }, [transactions, categories, accountMap, categoryMap]);

  return (
    <div className="glass-card dashboard-donut">
      <div className="dashboard-card-header">
        <h3 className="dashboard-card-title">Top Categories</h3>
      </div>
      <div className="dashboard-card-content">
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={90}
                paddingAngle={5}
                dataKey="value"
                stroke="none"
              >
                {data.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <RechartsTooltip content={<CustomTooltip />} />
              <Legend verticalAlign="bottom" height={36} iconType="circle" />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="empty-state-simple">No expenses this month</div>
        )}
      </div>
    </div>
  );
}
