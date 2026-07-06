import { listAccounts } from './accounts.ts';
import { listBudgets } from './budgets.ts';
import { listCategories } from './categories.ts';
import { listTransactions } from './transactions.ts';
import {
  buildAccountMap,
  buildCategoryMap,
  isExpense,
  isExcludedFromCashFlow,
  isIncome,
} from './transactionSemantics.ts';

export interface BudgetingReportInput {
  startDate?: string | null;
  endDate?: string | null;
  month?: string | null;
  globalBudget?: number | null;
  categoryPercents?: Record<string, number> | null;
  periodScale?: number | null;
}

export function getBudgetingReport(input: BudgetingReportInput = {}) {
  const transactions = listTransactions({
    startDate: input.startDate,
    endDate: input.endDate,
  }).transactions;
  const categories = listCategories().categories;
  const expenseCategories = categories.filter(category => category.type === 'expense');
  const budgets = listBudgets(input.month ? { month: input.month } : {});
  const accountMap = buildAccountMap(listAccounts({ includeArchived: true }).accounts);
  const categoryMap = buildCategoryMap(categories);

  const cashFlow = {
    income: 0,
    expenses: 0,
    byCategory: {} as Record<string, number>,
  };

  for (const transaction of transactions) {
    if (isExcludedFromCashFlow(transaction, accountMap, categoryMap)) continue;
    if (isIncome(transaction, accountMap, categoryMap)) {
      cashFlow.income += transaction.amount;
    }
    if (isExpense(transaction, accountMap, categoryMap)) {
      cashFlow.expenses += Math.abs(transaction.amount);
      const key = transaction.category?.id ? String(transaction.category.id) : 'uncategorized';
      cashFlow.byCategory[key] = (cashFlow.byCategory[key] ?? 0) + Math.abs(transaction.amount);
    }
  }

  const budgetByCategoryId = Object.fromEntries(budgets.map((budget: any) => [String(budget.categoryId), budget]));
  const periodScale = Number.isFinite(input.periodScale) && Number(input.periodScale) > 0 ? Number(input.periodScale) : 1;
  const categoryPercents = input.categoryPercents ?? {};
  const hasPercentTargets = Object.values(categoryPercents).some(value => Number(value) > 0);
  const autoGlobalBudget = cashFlow.income > 0 ? cashFlow.income : cashFlow.expenses;
  const baseGlobalBudget = Number.isFinite(input.globalBudget) && Number(input.globalBudget) > 0
    ? Number(input.globalBudget)
    : autoGlobalBudget;
  const globalBudget = baseGlobalBudget * periodScale;

  const categoryIds = new Set([
    ...expenseCategories.map(category => String(category.id)),
    ...Object.keys(cashFlow.byCategory),
    ...budgets.map((budget: any) => String(budget.categoryId)),
  ]);

  const rows = [...categoryIds]
    .map(categoryId => {
      const category = categoryId === 'uncategorized'
        ? { id: 'uncategorized', name: 'Uncategorized', color: '#94a3b8', type: 'expense' }
        : categoryMap[categoryId];
      if (!category) return null;

      const actual = cashFlow.byCategory[categoryId] ?? 0;
      const budget = budgetByCategoryId[categoryId];
      const targetPercent = Number(categoryPercents[categoryId]) || 0;
      const budgetAmount = hasPercentTargets && categoryId !== 'uncategorized'
        ? (targetPercent / 100) * globalBudget
        : Number(budget?.amount ?? 0);
      const effectiveTargetPercent = hasPercentTargets && categoryId !== 'uncategorized'
        ? targetPercent
        : globalBudget > 0 ? (budgetAmount / globalBudget) * 100 : 0;
      const actualPercent = cashFlow.expenses > 0 ? (actual / cashFlow.expenses) * 100 : 0;
      const variance = actual - budgetAmount;
      const status = budgetAmount <= 0 && actual > 0
        ? 'unplanned'
        : variance > Math.max(25, budgetAmount * 0.05)
          ? 'over'
          : 'aligned';

      return {
        category,
        actual,
        budgetAmount,
        targetPercent: effectiveTargetPercent,
        actualPercent,
        variance,
        status,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((a, b) => b.actual - a.actual || a.category.name.localeCompare(b.category.name));

  const budgetRemaining = globalBudget - cashFlow.expenses;
  const unspentIncome = Math.max(0, cashFlow.income - cashFlow.expenses);
  const overspentAmount = Math.max(0, cashFlow.expenses - cashFlow.income);

  return {
    input,
    cashFlow,
    globalBudget,
    rows,
    summary: {
      income: cashFlow.income,
      expenses: cashFlow.expenses,
      budgetRemaining,
      unspentIncome,
      overspentAmount,
      actualSpendPercent: globalBudget > 0 ? (cashFlow.expenses / globalBudget) * 100 : 0,
      targetTotalPercent: rows.reduce((sum, row) => sum + row.targetPercent, 0),
      overCount: rows.filter(row => row.status === 'over').length,
      unplannedCount: rows.filter(row => row.status === 'unplanned').length,
    },
  };
}

