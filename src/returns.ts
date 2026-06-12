export interface CashFlow {
  date: string;
  amount_cents: number;
}

export interface IrrInput {
  account_id: number;
  balances: BalanceSnapshot[];
  contribution_flows: CashFlow[];
}

export interface BalanceSnapshot {
  date: string;
  balance_cents: number;
}

export interface ReturnSummary {
  account_id: number;
  start_date: string;
  end_date: string;
  years: number;
  initial_balance_cents: number;
  ending_balance_cents: number;
  net_cash_flow_cents: number;
  irr: number | null;
  time_weighted_return: number | null;
  annualized_time_weighted_return: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / MS_PER_DAY;
}

export function calculateXirr(flows: CashFlow[]): number | null {
  const compact = new Map<string, number>();
  for (const flow of flows) {
    if (flow.amount_cents === 0) continue;
    compact.set(flow.date, (compact.get(flow.date) ?? 0) + flow.amount_cents);
  }

  const dated = [...compact]
    .map(([date, amount_cents]) => ({ date, amount_cents }))
    .filter((flow) => flow.amount_cents !== 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (dated.length < 2) return null;
  if (!dated.some((flow) => flow.amount_cents < 0) || !dated.some((flow) => flow.amount_cents > 0)) return null;

  const start = dated[0]!.date;
  const npv = (rate: number) => {
    let total = 0;
    for (const flow of dated) {
      total += flow.amount_cents / Math.pow(1 + rate, daysBetween(start, flow.date) / 365);
    }
    return total;
  };

  const low = -0.999999999;
  let high = 1;
  const lowValue = npv(low);
  let highValue = npv(high);
  for (let i = 0; i < 64 && Math.sign(lowValue) === Math.sign(highValue); i++) {
    high *= 2;
    highValue = npv(high);
  }
  if (Math.sign(lowValue) === Math.sign(highValue)) return null;

  let lo = low;
  let hi = high;
  for (let i = 0; i < 120; i++) {
    const mid = (lo + hi) / 2;
    const midValue = npv(mid);
    if (Math.abs(midValue) < 0.005) return mid;
    if (Math.sign(midValue) === Math.sign(lowValue)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function calculateTimeWeightedReturn(balances: BalanceSnapshot[], contributionFlows: CashFlow[]): number | null {
  const snapshots = compactBalances(balances);
  if (snapshots.length < 2) return null;

  let linked = 1;
  for (let i = 1; i < snapshots.length; i++) {
    const start = snapshots[i - 1]!;
    const end = snapshots[i]!;
    if (start.balance_cents <= 0 || end.balance_cents <= 0) return null;

    const periodDays = daysBetween(start.date, end.date);
    if (periodDays <= 0) return null;

    let netFlow = 0;
    let weightedFlow = 0;
    for (const flow of contributionFlows) {
      if (flow.date <= start.date || flow.date > end.date || flow.amount_cents === 0) continue;
      netFlow += flow.amount_cents;
      weightedFlow += flow.amount_cents * (daysBetween(flow.date, end.date) / periodDays);
    }

    const denominator = start.balance_cents + weightedFlow;
    if (Math.abs(denominator) < 1) return null;
    const periodReturn = (end.balance_cents - start.balance_cents - netFlow) / denominator;
    if (!Number.isFinite(periodReturn) || periodReturn <= -1) return null;
    linked *= 1 + periodReturn;
  }

  return linked - 1;
}

export function summarizeReturns(input: IrrInput): ReturnSummary | null {
  const balances = compactBalances(input.balances);
  if (balances.length < 2) return null;
  const first = balances[0]!;
  const last = balances[balances.length - 1]!;
  if (first.balance_cents <= 0 || last.balance_cents <= 0) return null;
  if (last.date <= first.date) return null;

  const investedFlows = input.contribution_flows
    .filter((flow) => flow.date > first.date && flow.date <= last.date)
    .map((flow) => ({
      date: flow.date,
      amount_cents: -flow.amount_cents,
    }));

  const cashFlows = [
    { date: first.date, amount_cents: -first.balance_cents },
    ...investedFlows,
    { date: last.date, amount_cents: last.balance_cents },
  ];
  const timeWeightedReturn = calculateTimeWeightedReturn(balances, input.contribution_flows);
  const years = daysBetween(first.date, last.date) / 365;

  return {
    account_id: input.account_id,
    start_date: first.date,
    end_date: last.date,
    years,
    initial_balance_cents: first.balance_cents,
    ending_balance_cents: last.balance_cents,
    net_cash_flow_cents: input.contribution_flows
      .filter((flow) => flow.date > first.date && flow.date <= last.date)
      .reduce((sum, flow) => sum + flow.amount_cents, 0),
    irr: calculateXirr(cashFlows),
    time_weighted_return: timeWeightedReturn,
    annualized_time_weighted_return:
      timeWeightedReturn === null || years <= 0 || 1 + timeWeightedReturn <= 0
        ? null
        : Math.pow(1 + timeWeightedReturn, 1 / years) - 1,
  };
}

function compactBalances(balances: BalanceSnapshot[]): BalanceSnapshot[] {
  const byDate = new Map<string, number>();
  for (const balance of balances) {
    byDate.set(balance.date, balance.balance_cents);
  }
  return [...byDate]
    .map(([date, balance_cents]) => ({ date, balance_cents }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
