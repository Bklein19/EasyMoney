import { getDb, syncLedgerReadModelFromLegacyTables } from '../database.js';
import type { NetWorthReport } from './types.ts';

interface CurrentLedgerBalanceRow {
  type: string | null;
  balanceCents: number | null;
}

interface LedgerBalanceRow {
  month: string;
  netWorthCents: number;
}

function isCreditType(type: string | null) {
  return type === 'credit' || type === 'credit_card' || type === 'credit-card';
}

function dollarsFromCents(cents: number) {
  return Math.round(cents) / 100;
}

export function getNetWorthReport(): NetWorthReport {
  syncLedgerReadModelFromLegacyTables();

  const currentRows = getDb()
    .prepare(
      `SELECT
         a.type,
         (
           SELECT lb.balanceCents
           FROM ledgerBalances lb
           WHERE lb.accountId = a.id
           ORDER BY lb.month DESC, lb.id DESC
           LIMIT 1
         ) AS balanceCents
       FROM accounts a
       ORDER BY a.id ASC`
    )
    .all() as CurrentLedgerBalanceRow[];

  const currentNetWorth = dollarsFromCents(currentRows.reduce((total, account) => {
    const balance = account.balanceCents ?? 0;
    return total + (isCreditType(account.type) ? -Math.abs(balance) : balance);
  }, 0));

  const history = getDb()
    .prepare(
      `SELECT
        lb.month,
        SUM(CASE
          WHEN a.type IN ('credit', 'credit_card', 'credit-card') THEN -ABS(lb.balanceCents)
          ELSE lb.balanceCents
        END) AS netWorthCents
       FROM ledgerBalances lb
       JOIN accounts a ON a.id = lb.accountId
       GROUP BY lb.month
       ORDER BY lb.month ASC`
    )
    .all() as LedgerBalanceRow[];

  const points = history.map(point => ({
    month: point.month,
    netWorth: dollarsFromCents(point.netWorthCents),
  }));

  const previous = points.at(-1)?.netWorth ?? 0;
  const percentChange = points.length < 1 || previous === 0
    ? currentNetWorth > 0 && previous === 0 ? 100 : 0
    : ((currentNetWorth - previous) / Math.abs(previous)) * 100;

  return {
    currentNetWorth,
    percentChange,
    history: points,
  };
}
