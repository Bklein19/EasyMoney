/** Read-only diagnostic, not a financial reconciliation certification. */
export interface EvidencePeriod { start: string; end: string }
export interface BalanceEvidence { date: string; amountCents: number; sourceFileId: number }
export interface ReconciliationInput {
  type: string;
  start: string;
  end: string;
  periods: EvidencePeriod[];
  balances: BalanceEvidence[];
  transactions: Array<{ date: string; amountCents: number }>;
}
const dayAfter = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
export function coverageGaps(periods: EvidencePeriod[], start: string, end: string): EvidencePeriod[] {
  let cursor = start;
  const gaps: EvidencePeriod[] = [];
  for (const period of [...periods].sort((a, b) => a.start.localeCompare(b.start))) {
    if (period.end < cursor || period.start > end) continue;
    if (period.start > cursor) gaps.push({ start: cursor, end: new Date(Date.parse(`${period.start}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) });
    cursor = dayAfter(period.end);
    if (cursor > end) break;
  }
  if (cursor <= end) gaps.push({ start: cursor, end });
  return gaps;
}
export function reconcileAccountEvidence(input: ReconciliationInput) {
  const byDate = new Map<string, BalanceEvidence[]>();
  for (const balance of input.balances.filter(b => b.date <= input.end)) {
    const group = byDate.get(balance.date) ?? [];
    group.push(balance);
    byDate.set(balance.date, group);
  }
  const dates = [...byDate.keys()].sort();
  const conflicts = dates.filter(date => new Set(byDate.get(date)!.map(b => b.amountCents)).size > 1);
  const windows = dates.slice(1).filter(date => date >= input.start).map(date => {
    const previous = dates[dates.indexOf(date) - 1]!;
    const start = dayAfter(previous);
    const opening = byDate.get(previous)!;
    const closing = byDate.get(date)!;
    const gaps = coverageGaps(input.periods, start, date);
    const ledgerNetCents = input.transactions.filter(t => t.date > previous && t.date <= date).reduce((sum, t) => sum + t.amountCents, 0);
    const conflict = conflicts.includes(previous) || conflicts.includes(date);
    const supported = ['checking', 'savings', 'credit'].includes(input.type);
    const residualCents = conflict || !supported ? null : closing[0]!.amountCents - opening[0]!.amountCents - ledgerNetCents;
    const status = conflict ? 'balance-conflict' : !supported ? 'unsupported-account-type' : gaps.length ? 'coverage-unverified' : residualCents === 0 ? 'balanced' : 'mismatch';
    return { start, end: date, openingDate: previous, openingSources: opening.map(b => b.sourceFileId), closingSources: closing.map(b => b.sourceFileId), ledgerNetCents, residualCents, status, gaps };
  });
  return {
    coverageGaps: coverageGaps(input.periods, input.start, input.end),
    balanceConflicts: conflicts,
    windows,
    caveats: ['Balances and coverage are parser-derived; independent PDF validation remains necessary.', 'Zero residual cannot detect offsetting errors or prove individual transaction identity.', 'Windows assume end-of-day balances and ledger dates aligned with statement posting dates.'],
  };
}
