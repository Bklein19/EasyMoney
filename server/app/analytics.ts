import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  endOfYear,
  format,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from 'date-fns';
import { listAccounts } from './accounts.ts';
import { listCategories } from './categories.ts';
import { listTransactions } from './transactions.ts';
import { resolveAutoGrouping } from './analyticsGrouping.ts';
import {
  buildAccountMap,
  buildCategoryMap,
  getTransactionFlow,
  isExpense,
  isIncome,
  isInvestmentMovement,
} from './transactionSemantics.ts';
import type { ListTransactionsOptions, TransactionListItem } from './types';

export type AnalyticsGroupMode = 'Auto' | 'Daily' | 'Weekly' | 'Monthly' | 'Yearly';
export type CategoryFilterMode = 'include' | 'exclude';

export interface AnalyticsReportInput {
  startDate?: string | null;
  endDate?: string | null;
  accountId?: string | number | null;
  categoryFilterIds?: Array<string | number>;
  categoryFilterMode?: CategoryFilterMode | null;
  groupMode?: AnalyticsGroupMode | null;
}

function resolveGrouping(transactions: TransactionListItem[], groupMode: AnalyticsGroupMode) {
  if (groupMode === 'Daily') return { labelFormat: 'MMM d', keyFormat: 'yyyy-MM-dd' };
  if (groupMode === 'Weekly') return { labelFormat: 'week', keyFormat: 'week' };
  if (groupMode === 'Monthly') return { labelFormat: 'MMM yyyy', keyFormat: 'yyyy-MM' };
  if (groupMode === 'Yearly') return { labelFormat: 'yyyy', keyFormat: 'yyyy' };

  const dates = transactions.map(transaction => new Date(transaction.date).getTime());
  const diffDays = dates.length
    ? (Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24)
    : 0;

  return resolveAutoGrouping(diffDays);
}

function periodFor(date: string, keyFormat: string, labelFormat: string) {
  const dateObj = parseISO(date);
  const weekStart = startOfWeek(dateObj);
  const key = keyFormat === 'week' ? format(weekStart, 'yyyy-MM-dd') : format(dateObj, keyFormat);
  const label = keyFormat === 'week' ? `Week of ${format(weekStart, 'MMM d')}` : format(dateObj, labelFormat);
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

  return {
    key,
    label,
    startDate: format(periodStart, 'yyyy-MM-dd'),
    endDate: format(periodEnd, 'yyyy-MM-dd'),
  };
}

function categoryKey(transaction: TransactionListItem) {
  return transaction.category?.id ? String(transaction.category.id) : 'uncategorized';
}

function categoryName(transaction: TransactionListItem) {
  return transaction.category?.name ?? 'Uncategorized';
}

function categoryColor(transaction: TransactionListItem) {
  return transaction.category?.color ?? '#94a3b8';
}

function merchantName(transaction: TransactionListItem) {
  return transaction.merchant || transaction.description || 'Unknown';
}

function normalizeMerchant(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || 'unknown';
}

function applyCategoryFilter(transactions: TransactionListItem[], input: AnalyticsReportInput) {
  const selected = new Set((input.categoryFilterIds ?? []).map(String));
  if (selected.size === 0) return transactions;
  const mode = input.categoryFilterMode ?? 'include';
  return transactions.filter(transaction => {
    const isSelected = selected.has(categoryKey(transaction));
    return mode === 'include' ? isSelected : !isSelected;
  });
}

export function getAnalyticsReport(input: AnalyticsReportInput = {}) {
  const query: ListTransactionsOptions = {
    startDate: input.startDate,
    endDate: input.endDate,
    accountId: input.accountId,
  };
  const transactionResponse = listTransactions(query);
  const categoryScopedTransactions = applyCategoryFilter(transactionResponse.transactions, input);
  const accountMap = buildAccountMap(listAccounts({ includeArchived: true }).accounts);
  const categoryMap = buildCategoryMap(listCategories().categories);
  const analysisTransactions = categoryScopedTransactions.filter(transaction => {
    const flow = getTransactionFlow(transaction, accountMap, categoryMap);
    return flow !== 'transfer' && flow !== 'card_payment' && flow !== 'internal_transfer' && flow !== 'investment';
  });

  const summary = {
    income: 0,
    expenses: 0,
    internalMovement: 0,
    investments: 0,
    net: 0,
    transactionCount: categoryScopedTransactions.length,
  };

  for (const transaction of categoryScopedTransactions) {
    const flow = getTransactionFlow(transaction, accountMap, categoryMap);
    if (flow === 'income') summary.income += transaction.amount;
    else if (flow === 'expense') summary.expenses += Math.abs(transaction.amount);
    else if (flow === 'investment') summary.investments += Math.abs(transaction.amount);
    else if (flow === 'transfer' || flow === 'card_payment' || flow === 'internal_transfer') {
      summary.internalMovement += Math.abs(transaction.amount);
    }
  }
  summary.net = summary.income - summary.expenses;

  const { labelFormat, keyFormat } = resolveGrouping(categoryScopedTransactions, input.groupMode ?? 'Auto');

  const cashFlowByPeriod = new Map<string, {
    key: string;
    label: string;
    startDate: string;
    endDate: string;
    income: number;
    expenses: number;
    net: number;
    categoryAmounts: Record<string, number>;
    transactionIds: number[];
  }>();
  const spendingByCategory = new Map<string, {
    id: string;
    name: string;
    amount: number;
    color: string;
    transactionIds: number[];
  }>();
  const merchants = new Map<string, {
    normalized: string;
    name: string;
    amount: number;
    count: number;
    transactionIds: number[];
  }>();
  const incomeStreams = new Map<string, {
    normalized: string;
    name: string;
    amount: number;
    count: number;
    transactionIds: number[];
  }>();
  const investmentsByPeriod = new Map<string, {
    key: string;
    label: string;
    amount: number;
    transactionIds: number[];
  }>();

  for (const transaction of categoryScopedTransactions) {
    const period = periodFor(transaction.date, keyFormat, labelFormat);
    const periodRow = cashFlowByPeriod.get(period.key) ?? {
      key: period.key,
      label: period.label,
      startDate: period.startDate,
      endDate: period.endDate,
      income: 0,
      expenses: 0,
      net: 0,
      categoryAmounts: {},
      transactionIds: [],
    };
    if (isIncome(transaction, accountMap, categoryMap)) periodRow.income += transaction.amount;
    if (isExpense(transaction, accountMap, categoryMap)) {
      const amount = Math.abs(transaction.amount);
      const name = categoryName(transaction);
      periodRow.expenses += amount;
      periodRow.categoryAmounts[name] = (periodRow.categoryAmounts[name] ?? 0) + amount;
    }
    periodRow.net = periodRow.income - periodRow.expenses;
    periodRow.transactionIds.push(transaction.id);
    cashFlowByPeriod.set(period.key, periodRow);

    if (isExpense(transaction, accountMap, categoryMap)) {
      const key = categoryKey(transaction);
      const categoryRow = spendingByCategory.get(key) ?? {
        id: key,
        name: categoryName(transaction),
        amount: 0,
        color: categoryColor(transaction),
        transactionIds: [],
      };
      categoryRow.amount += Math.abs(transaction.amount);
      categoryRow.transactionIds.push(transaction.id);
      spendingByCategory.set(key, categoryRow);

      const normalized = normalizeMerchant(merchantName(transaction));
      const merchantRow = merchants.get(normalized) ?? {
        normalized,
        name: merchantName(transaction),
        amount: 0,
        count: 0,
        transactionIds: [],
      };
      merchantRow.amount += Math.abs(transaction.amount);
      merchantRow.count += 1;
      merchantRow.transactionIds.push(transaction.id);
      merchants.set(normalized, merchantRow);
    }

    if (isIncome(transaction, accountMap, categoryMap)) {
      const normalized = normalizeMerchant(merchantName(transaction));
      const incomeRow = incomeStreams.get(normalized) ?? {
        normalized,
        name: merchantName(transaction),
        amount: 0,
        count: 0,
        transactionIds: [],
      };
      incomeRow.amount += Math.abs(transaction.amount);
      incomeRow.count += 1;
      incomeRow.transactionIds.push(transaction.id);
      incomeStreams.set(normalized, incomeRow);
    }

    if (isInvestmentMovement(transaction, accountMap, categoryMap)) {
      const investmentPeriod = periodFor(transaction.date, keyFormat, labelFormat);
      const investmentRow = investmentsByPeriod.get(investmentPeriod.key) ?? {
        key: investmentPeriod.key,
        label: investmentPeriod.label,
        amount: 0,
        transactionIds: [],
      };
      investmentRow.amount += Math.abs(transaction.amount);
      investmentRow.transactionIds.push(transaction.id);
      investmentsByPeriod.set(investmentPeriod.key, investmentRow);
    }
  }

  return {
    input,
    summary,
    cashFlow: [...cashFlowByPeriod.values()].sort((a, b) => a.key.localeCompare(b.key)),
    spendingByCategory: [...spendingByCategory.values()].sort((a, b) => b.amount - a.amount),
    topMerchants: [...merchants.values()].sort((a, b) => b.amount - a.amount).slice(0, 10),
    incomeStreams: [...incomeStreams.values()].sort((a, b) => b.amount - a.amount),
    investments: [...investmentsByPeriod.values()].sort((a, b) => a.key.localeCompare(b.key)),
    transactions: categoryScopedTransactions,
    analysisTransactions,
  };
}
