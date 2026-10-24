import type { ReportIncomeSource } from '../../../server/app/reportIncomeSources';

export function incomeSourceSeries(rows: ReportIncomeSource[], accountIds: Set<number>) {
  const selected = rows.filter((row) => accountIds.has(row.account_id));
  const totals = new Map<string, { source: string; label: string; amount: number }>();
  for (const row of selected) {
    const total = totals.get(row.source) ?? { source: row.source, label: row.label, amount: 0 };
    total.amount += row.amount_cents / 100;
    totals.set(row.source, total);
  }
  // Keep the optional overlay readable without losing smaller sources.
  const ranked = [...totals.values()].sort(
    (a, b) => b.amount - a.amount || a.source.localeCompare(b.source),
  );
  const largest = new Set(ranked.slice(0, 5).map((row) => row.source));
  const series = ranked.slice(0, 5).map((row, index) => ({ ...row, key: `income_${index}` }));
  if (ranked.length > 5)
    series.push({
      source: 'remaining',
      label: 'Other income sources',
      key: 'income_5',
      amount: ranked.slice(5).reduce((sum, row) => sum + row.amount, 0),
    });

  return {
    series,
    at(period: string, cumulative: boolean): Record<string, number> {
      return Object.fromEntries(
        series.map((source) => [
          source.key,
          selected.reduce((sum, row) => {
            const matchesSource =
              source.source === 'remaining'
                ? !largest.has(row.source)
                : row.source === source.source;
            const periodMatches = cumulative
              ? row.month <= period
              : period.includes(' Q')
                ? `${row.month.slice(0, 4)} Q${Math.ceil(Number(row.month.slice(5, 7)) / 3)}` ===
                  period
                : row.month.startsWith(period);
            return sum + (matchesSource && periodMatches ? row.amount_cents / 100 : 0);
          }, 0),
        ]),
      );
    },
  };
}
