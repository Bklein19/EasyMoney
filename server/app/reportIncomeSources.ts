export interface ReportIncomeTransaction {
  month: string;
  account_id: number;
  account_type: string;
  amount_cents: number;
  description: string;
  category_id: number | null;
  category_name: string | null;
  category_type: string | null;
}

export interface ReportIncomeSource {
  month: string;
  account_id: number;
  source: string;
  label: string;
  amount_cents: number;
}

/** Received cash, not an allocation of retained contributions or gross compensation. */
export function reportIncomeSources(transactions: ReportIncomeTransaction[]): ReportIncomeSource[] {
  const sources = new Map<string, ReportIncomeSource>();
  for (const transaction of transactions) {
    if (transaction.amount_cents <= 0 || transaction.category_type !== 'income') continue;
    // Security sales, reinvestments and card credits aren't new household cash income.
    if (!['checking', 'savings', 'cash'].includes(transaction.account_type)) continue;
    if (transaction.category_id === null) continue;
    const source = `category_${transaction.category_id}`;
    const label = transaction.category_name ?? 'Income';
    const key = `${transaction.month}|${transaction.account_id}|${source}`;
    const row = sources.get(key) ?? {
      month: transaction.month,
      account_id: transaction.account_id,
      source,
      label,
      amount_cents: 0,
    };
    row.amount_cents += transaction.amount_cents;
    sources.set(key, row);
  }
  return [...sources.values()].sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      a.account_id - b.account_id ||
      a.source.localeCompare(b.source),
  );
}
