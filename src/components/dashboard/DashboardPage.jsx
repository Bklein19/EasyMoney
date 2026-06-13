import { useMemo } from 'react';
import { ArrowDownRight, ArrowUpRight, TrendingUp, Wallet } from 'lucide-react';
import { useTransactions } from '../../hooks/useTransactions';
import { useAccounts } from '../../hooks/useAccounts';
import { useCategories } from '../../hooks/useCategories';
import { buildAccountMap, isExpense, isIncome, isInvestmentMovement } from '../../utils/transactionSemantics';
import NetWorthCard from './NetWorthCard';
import KPICard from './KPICard';
import SpendingDonut from './SpendingDonut';
import MonthlyTrendChart from './MonthlyTrendChart';
import RecentTransactions from './RecentTransactions';
import InvestmentSnapshotCard from './InvestmentSnapshotCard';
import './DashboardPage.css';

export default function DashboardPage() {
  const { transactions } = useTransactions();
  const { accounts } = useAccounts();
  const { categories } = useCategories();
  const accountMap = useMemo(() => buildAccountMap(accounts), [accounts]);
  const categoryMap = useMemo(() => {
    const map = {};
    categories.forEach(c => { map[c.id] = c; });
    return map;
  }, [categories]);

  const currentMonthData = useMemo(() => {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    // Get last month for trend
    let prevYear = now.getFullYear();
    let prevMonthNum = now.getMonth();
    if (prevMonthNum === 0) {
      prevMonthNum = 12;
      prevYear -= 1;
    }
    const prevMonth = `${prevYear}-${String(prevMonthNum).padStart(2, '0')}`;

    let income = 0;
    let expense = 0;
    let investments = 0;
    let prevIncome = 0;
    let prevExpense = 0;
    let prevInvestments = 0;

    transactions.forEach(t => {
      if (t.date.startsWith(currentMonth)) {
        if (isIncome(t, accountMap, categoryMap)) income += t.amount;
        else if (isExpense(t, accountMap, categoryMap)) expense += Math.abs(t.amount);
        else if (isInvestmentMovement(t, accountMap, categoryMap)) investments += Math.abs(t.amount);
      } else if (t.date.startsWith(prevMonth)) {
        if (isIncome(t, accountMap, categoryMap)) prevIncome += t.amount;
        else if (isExpense(t, accountMap, categoryMap)) prevExpense += Math.abs(t.amount);
        else if (isInvestmentMovement(t, accountMap, categoryMap)) prevInvestments += Math.abs(t.amount);
      }
    });

    const calcTrend = (curr, prev) => {
      if (prev === 0) return curr > 0 ? 100 : 0;
      return ((curr - prev) / prev) * 100;
    };

    return {
      income,
      expense,
      savings: income - expense,
      investments,
      incomeTrend: calcTrend(income, prevIncome),
      expenseTrend: calcTrend(expense, prevExpense),
      savingsTrend: calcTrend(income - expense, prevIncome - prevExpense),
      investmentsTrend: calcTrend(investments, prevInvestments),
    };
  }, [transactions, accountMap, categoryMap]);

  return (
    <div className="page dashboard-page">
      <div className="page__header stagger-in">
        <div>
          <h1 className="page__title">Overview</h1>
          <p className="page__subtitle">Welcome back. Here is your financial summary.</p>
        </div>
      </div>

      <div className="dashboard-grid stagger-in">
        <div className="dashboard-kpi-group">
          <NetWorthCard />
          <KPICard
            title="Income (This Month)"
            amount={currentMonthData.income}
            trend={currentMonthData.incomeTrend}
            icon={ArrowUpRight}
          />
          <KPICard
            title="Expenses (This Month)"
            amount={currentMonthData.expense}
            trend={currentMonthData.expenseTrend}
            // Trend is inverted for expenses (down is good)
            icon={ArrowDownRight}
            trendLabel="vs last month"
          />
          <KPICard
            title="Savings (This Month)"
            amount={currentMonthData.savings}
            trend={currentMonthData.savingsTrend}
            icon={Wallet}
          />
          <KPICard
            title="Investments (This Month)"
            amount={currentMonthData.investments}
            trend={currentMonthData.investmentsTrend}
            icon={TrendingUp}
          />
        </div>

        <MonthlyTrendChart />
        <InvestmentSnapshotCard />
        <SpendingDonut />
        <RecentTransactions />
      </div>
    </div>
  );
}
