import { startOfMonth, endOfMonth, eachMonthOfInterval, format } from 'date-fns';
import { isCreditAccount } from './transactionSemantics';

/**
 * Calculate total income from transactions
 */
export function calcTotalIncome(transactions) {
  return transactions
    .filter(t => t.amount > 0)
    .reduce((sum, t) => sum + t.amount, 0);
}

/**
 * Calculate total expenses from transactions
 */
export function calcTotalExpenses(transactions) {
  return transactions
    .filter(t => t.amount < 0)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
}

/**
 * Calculate savings rate: (income - expenses) / income * 100
 */
export function calcSavingsRate(transactions) {
  const income = calcTotalIncome(transactions);
  const expenses = calcTotalExpenses(transactions);
  if (income === 0) return 0;
  return ((income - expenses) / income) * 100;
}

/**
 * Calculate net worth from accounts
 * Assets (checking, savings, investment, cash) - Liabilities (credit_card)
 */
export function calcNetWorth(accounts) {
  return accounts.reduce((total, account) => {
    const balance = account.currentBalance || 0;
    // Credit cards are liabilities — their balance is what you owe
    if (isCreditAccount(account)) {
      return total - Math.abs(balance);
    }
    return total + balance;
  }, 0);
}

/**
 * Group transactions by month key (YYYY-MM) and aggregate
 */
export function groupByMonth(transactions) {
  const grouped = {};
  for (const t of transactions) {
    const date = new Date(t.date);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!grouped[key]) {
      grouped[key] = { income: 0, expenses: 0, transactions: [] };
    }
    grouped[key].transactions.push(t);
    if (t.amount > 0) {
      grouped[key].income += t.amount;
    } else {
      grouped[key].expenses += Math.abs(t.amount);
    }
  }
  return grouped;
}

/**
 * Group transactions by category with totals
 */
export function groupByCategory(transactions, categories) {
  const grouped = {};
  for (const t of transactions) {
    const catId = t.categoryId || 'uncategorized';
    if (!grouped[catId]) {
      const cat = categories.find(c => c.id === catId);
      grouped[catId] = {
        categoryId: catId,
        name: cat?.name || 'Uncategorized',
        color: cat?.color || '#94a3b8',
        icon: cat?.icon || 'help-circle',
        total: 0,
        count: 0,
        transactions: [],
      };
    }
    grouped[catId].total += Math.abs(t.amount);
    grouped[catId].count += 1;
    grouped[catId].transactions.push(t);
  }
  return Object.values(grouped).sort((a, b) => b.total - a.total);
}

/**
 * Get top N merchants by total spend
 */
export function getTopMerchants(transactions, limit = 10) {
  const merchants = {};
  for (const t of transactions) {
    if (t.amount >= 0) continue; // Only expenses
    const name = cleanMerchantName(t.description);
    if (!merchants[name]) {
      merchants[name] = { name, total: 0, count: 0 };
    }
    merchants[name].total += Math.abs(t.amount);
    merchants[name].count += 1;
  }
  return Object.values(merchants)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/**
 * Clean up merchant name for grouping
 */
function cleanMerchantName(description) {
  if (!description) return 'Unknown';
  // Remove common suffixes like store numbers, locations
  let name = description
    .replace(/\s*#\d+.*/i, '')
    .replace(/\s*\d{5,}.*/i, '')
    .replace(/\s*(store|branch|location)\s*\d*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Capitalize each word
  return name
    .toLowerCase()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, 30);
}

/**
 * Generate monthly data points for charts, filling gaps
 */
export function generateMonthlyTimeSeries(transactions, startDate, endDate) {
  const months = eachMonthOfInterval({ start: startDate, end: endDate });
  const grouped = groupByMonth(transactions);

  return months.map(month => {
    const key = format(month, 'yyyy-MM');
    const data = grouped[key] || { income: 0, expenses: 0 };
    return {
      month: key,
      label: format(month, 'MMM yyyy'),
      shortLabel: format(month, 'MMM'),
      income: Math.round(data.income * 100) / 100,
      expenses: Math.round(data.expenses * 100) / 100,
      net: Math.round((data.income - data.expenses) * 100) / 100,
    };
  });
}

/**
 * Calculate percentage change between two values
 */
export function calcPercentChange(current, previous) {
  if (previous === 0) {
    return current === 0 ? 0 : 100;
  }
  return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Get date range presets
 */
export function getDateRangePreset(preset) {
  const now = new Date();
  switch (preset) {
    case 'this-month':
      return { start: startOfMonth(now), end: now };
    case 'last-month': {
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { start: startOfMonth(lastMonth), end: endOfMonth(lastMonth) };
    }
    case 'last-3-months':
      return { start: new Date(now.getFullYear(), now.getMonth() - 2, 1), end: now };
    case 'last-6-months':
      return { start: new Date(now.getFullYear(), now.getMonth() - 5, 1), end: now };
    case 'ytd':
      return { start: new Date(now.getFullYear(), 0, 1), end: now };
    case 'last-year':
      return { start: new Date(now.getFullYear() - 1, 0, 1), end: new Date(now.getFullYear() - 1, 11, 31) };
    case 'all':
      return { start: new Date(2000, 0, 1), end: now };
    default:
      return { start: startOfMonth(now), end: now };
  }
}
