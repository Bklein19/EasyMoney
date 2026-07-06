/**
 * Format a number as USD currency
 */
export function formatCurrency(amount: number, showSign = false) {
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(amount));

  if (showSign && amount !== 0) {
    return amount > 0 ? `+${formatted}` : `-${formatted}`;
  }
  return amount < 0 ? `-${formatted}` : formatted;
}

/**
 * Format a number as a compact currency (e.g., $12.3K)
 */
export function formatCurrencyCompact(amount: number) {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) {
    return `${amount < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${amount < 0 ? '-' : ''}$${(abs / 1_000).toFixed(1)}K`;
  }
  return formatCurrency(amount);
}

/**
 * Format a percentage with sign
 */
export function formatPercent(value: number, decimals = 1) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

/**
 * Format a date for display
 */
export function formatDate(dateStr: string, style: 'short' | 'medium' | 'long' | 'month' | 'iso' = 'short') {
  const date = new Date(dateStr);
  switch (style) {
    case 'short':
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    case 'medium':
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    case 'long':
      return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    case 'month':
      return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    case 'iso':
      return dateStr.slice(0, 10);
    default:
      return date.toLocaleDateString();
  }
}

/**
 * Get a month key (YYYY-MM) from a date string
 */
export function getMonthKey(dateStr: string) {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Format a month key for display
 */
export function formatMonthKey(monthKey: string) {
  const [year, month] = monthKey.split('-');
  const date = new Date(parseInt(year), parseInt(month) - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/**
 * Truncate text with ellipsis
 */
export function truncateText(text: string | null | undefined, maxLength = 30) {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…';
}

/**
 * Get account type label
 */
export function getAccountTypeLabel(type: string) {
  const labels = {
    checking: 'Checking',
    savings: 'Savings',
    credit: 'Credit Card',
    credit_card: 'Credit Card',
    investment: 'Investment',
    cash: 'Cash',
    other: 'Other',
  };
  return labels[type as keyof typeof labels] || type;
}

/**
 * Get the CSS class for an amount
 */
export function getAmountClass(amount: number) {
  if (amount > 0) return 'amount--positive';
  if (amount < 0) return 'amount--negative';
  return 'amount--neutral';
}
