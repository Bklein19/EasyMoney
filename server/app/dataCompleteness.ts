import { getDb } from '../database';
import { localCalendarDate } from './calendarDate';
import { getDataFreshnessReport } from './dataFreshness';

interface Interval { start: string; end: string }
const nextDay = (date: string, delta = 1) => new Date(Date.parse(`${date}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);

export function uncoveredIntervals(intervals: Interval[], start: string, end: string): Interval[] {
  const gaps: Interval[] = [];
  let cursor = start;
  for (const interval of [...intervals].sort((a, b) => a.start.localeCompare(b.start))) {
    if (interval.end < cursor || interval.start > end) continue;
    if (interval.start > cursor) gaps.push({ start: cursor, end: nextDay(interval.start, -1) });
    cursor = interval.end >= end ? nextDay(end) : nextDay(interval.end);
    if (cursor > end) break;
  }
  if (cursor <= end) gaps.push({ start: cursor, end });
  return gaps;
}

export function getDataCompleteness(input: { accountIds?: number[]; startDate?: string | null; endDate?: string | null; today?: string } = {}) {
  const today = input.today || localCalendarDate();
  const end = input.endDate ? input.endDate.slice(0, 10) < today ? input.endDate.slice(0, 10) : today : today;
  const freshness = getDataFreshnessReport({ today: end });
  const accounts = freshness.accounts.filter(account => !input.accountIds || input.accountIds.includes(account.accountId));
  const ranges = getDb().prepare(`SELECT sa.accountId, sf.coveredFrom, sf.coveredTo, sf.coverageBasis,
    MIN(st.date) AS firstTransactionDate, MAX(st.date) AS lastTransactionDate,
    (SELECT COUNT(*) FROM sourceAccounts peers WHERE peers.sourceFileId = sf.id) AS sourceAccountCount
    FROM sourceAccounts sa JOIN sourceFiles sf ON sf.id = sa.sourceFileId
    LEFT JOIN sourceTransactions st ON st.sourceAccountId = sa.id AND st.sourceFileId = sf.id AND SUBSTR(st.date, 1, 10) <= ?
    WHERE sf.status = 'committed' AND sa.accountId IS NOT NULL
    GROUP BY sa.id`).all(end) as Array<{ accountId: number; coveredFrom: string | null; coveredTo: string | null; coverageBasis: string | null;
      firstTransactionDate: string | null; lastTransactionDate: string | null; sourceAccountCount: number }>;
  const result = accounts.map(account => {
    const accountRanges = ranges.filter(range => range.accountId === account.accountId);
    const observedStart = accountRanges.map(range => range.firstTransactionDate).filter((date): date is string => Boolean(date)).sort()[0];
    const latestTransactionDate = accountRanges.map(range => range.lastTransactionDate).filter((date): date is string => Boolean(date)).sort().at(-1) || null;
    const start = input.startDate?.slice(0, 10) || observedStart?.slice(0, 10) || end;
    const declared = accountRanges.filter(range => range.coverageBasis === 'declared' && range.sourceAccountCount === 1 && range.coveredFrom && range.coveredTo)
      .map(range => ({ start: range.coveredFrom!.slice(0, 10), end: range.coveredTo!.slice(0, 10) }))
      .filter(range => /^\d{4}-\d{2}-\d{2}$/.test(range.start) && /^\d{4}-\d{2}-\d{2}$/.test(range.end) && range.start <= range.end);
    const gaps = start <= end ? uncoveredIntervals(declared, start, end) : [];
    // Query as-of balances independently: a recent transaction does not refresh an older balance.
    const latestBalance = getDb().prepare(`SELECT MAX(sb.date) AS date FROM sourceBalances sb
      JOIN sourceAccounts sa ON sa.id = sb.sourceAccountId JOIN sourceFiles sf ON sf.id = sb.sourceFileId
      WHERE sf.status = 'committed' AND sa.accountId = ? AND SUBSTR(sb.date, 1, 10) <= ?`).get(account.accountId, end) as { date: string | null };
    const age = latestBalance.date ? Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${latestBalance.date.slice(0, 10)}T00:00:00Z`)) / 86400000) : null;
    const balanceStatus = age === null ? 'missing' : age > 45 ? 'stale' : age > 30 ? 'due' : 'current';
    return { accountId: account.accountId, accountName: account.accountName, closed: account.accountStatus === 'closed',
      start, end, latestTransactionDate, latestBalanceDate: latestBalance.date,
      balanceStatus, transactionCoverage: start > end ? 'future' : gaps.length ? 'unverified' : 'declared', gaps,
      declaredRangeCount: declared.length, observedStart: observedStart || null };
  });
  return { asOf: end, accounts: result };
}
