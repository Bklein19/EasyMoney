import { classifyFlow } from "./flowClassification";

export interface AccountTransferSeed {
  account_id: number;
  firstMonth: string | null;
  startingAmount: number;
  contributionAdjustments: Map<string, number>;
}

export interface TransferTransaction {
  id: string;
  date: string;
  month: string;
  account_id: number;
  amount_cents: number;
  description: string;
}

export interface TransferAdjustment {
  link_id: string;
  reason: "starting-balance-transfer" | "cash-transfer";
  account_id: number;
  month: string;
  contributions_cents: number;
  gains_cents: number;
}

export interface TransferLink {
  id: string;
  reason: TransferAdjustment["reason"];
  source_account_id: number;
  destination_account_id: number;
  source_transaction_ids: string[];
  destination_transaction_ids: string[];
  amount_cents: number;
  basis_cents: number;
  gains_cents: number;
}

export interface TransferDerivation {
  links: TransferLink[];
  adjustments: TransferAdjustment[];
}

interface FlowTotals {
  contributions: number;
  dividends: number;
  interest: number;
}

export function deriveTransferLinks(input: {
  accounts: Array<{ id: number }>;
  sortedMonths: string[];
  flows: Map<string, FlowTotals>;
  balances: Map<string, number>;
  seeds: Map<number, AccountTransferSeed>;
  transactions: TransferTransaction[];
}): TransferDerivation {
  const flowKey = (month: string, accountId: number) => `${month}|${accountId}`;
  const monthBefore = (m: string) => input.sortedMonths[input.sortedMonths.indexOf(m) - 1] ?? null;
  const links: TransferLink[] = [];
  const adjustments: TransferAdjustment[] = [];

  const contributionAdjustments = new Map<number, Map<string, number>>();
  const gainsAdjustments = new Map<number, Map<string, number>>();
  for (const seed of input.seeds.values()) {
    contributionAdjustments.set(seed.account_id, new Map(seed.contributionAdjustments));
    gainsAdjustments.set(seed.account_id, new Map());
  }

  const addAdjustment = (adj: TransferAdjustment) => {
    adjustments.push(adj);
    const c = contributionAdjustments.get(adj.account_id) ?? new Map<string, number>();
    c.set(adj.month, (c.get(adj.month) ?? 0) + adj.contributions_cents);
    contributionAdjustments.set(adj.account_id, c);

    const g = gainsAdjustments.get(adj.account_id) ?? new Map<string, number>();
    g.set(adj.month, (g.get(adj.month) ?? 0) + adj.gains_cents);
    gainsAdjustments.set(adj.account_id, g);
  };

  const basisThrough = (accountId: number, beforeMonth: string): number => {
    let cum = 0;
    const accountAdjustments = contributionAdjustments.get(accountId);
    for (const month of input.sortedMonths) {
      if (month >= beforeMonth) break;
      const f = input.flows.get(flowKey(month, accountId));
      cum += (f?.contributions ?? 0) + (accountAdjustments?.get(month) ?? 0);
      if (cum < 0) cum = 0;
    }
    return cum;
  };

  const balanceBefore = (accountId: number, beforeMonth: string): number => {
    let latest = 0;
    for (const month of input.sortedMonths) {
      if (month >= beforeMonth) break;
      const b = input.balances.get(flowKey(month, accountId));
      if (b !== undefined) latest = b;
    }
    return latest;
  };

  for (const account of input.accounts) {
    const seed = input.seeds.get(account.id);
    if (!seed?.firstMonth || seed.startingAmount < 100_000) continue;

    const candidates: Array<{ id: number; outflowMonth: string }> = [];
    for (const other of input.accounts) {
      if (other.id === account.id) continue;
      for (const month of [seed.firstMonth, monthBefore(seed.firstMonth)]) {
        if (!month) continue;
        const out = input.flows.get(flowKey(month, other.id))?.contributions ?? 0;
        if (out < 0 && Math.abs(out) >= seed.startingAmount * 0.95 && Math.abs(out) <= seed.startingAmount * 1.05) {
          candidates.push({ id: other.id, outflowMonth: month });
          break;
        }
      }
    }
    if (candidates.length !== 1) continue;

    const source = candidates[0]!;
    const sourceBasis = basisThrough(source.id, source.outflowMonth);
    const basisCarried = Math.min(seed.startingAmount, sourceBasis);
    const gainsCarried = seed.startingAmount - basisCarried;
    const sourceOutflow = input.flows.get(flowKey(source.outflowMonth, source.id))?.contributions ?? 0;
    const sourceBasisPart = -Math.min(-sourceOutflow, sourceBasis);
    const sourceGainsPart = sourceOutflow - sourceBasisPart;
    const linkId = `starting:${source.id}:${source.outflowMonth}->${account.id}:${seed.firstMonth}`;

    links.push({
      id: linkId,
      reason: "starting-balance-transfer",
      source_account_id: source.id,
      destination_account_id: account.id,
      source_transaction_ids: [],
      destination_transaction_ids: [],
      amount_cents: seed.startingAmount,
      basis_cents: basisCarried,
      gains_cents: gainsCarried,
    });

    addAdjustment({
      link_id: linkId,
      reason: "starting-balance-transfer",
      account_id: account.id,
      month: seed.firstMonth,
      contributions_cents: basisCarried - seed.startingAmount,
      gains_cents: gainsCarried,
    });
    if (sourceGainsPart !== 0) {
      addAdjustment({
        link_id: linkId,
        reason: "starting-balance-transfer",
        account_id: source.id,
        month: source.outflowMonth,
        contributions_cents: -sourceGainsPart,
        gains_cents: sourceGainsPart,
      });
    }
  }

  const contributionTxs = input.transactions.filter(
    (t) => classifyFlow(t.description) === "contribution" && Math.abs(t.amount_cents) >= 1_000_000
  );
  const outflows = contributionTxs.filter((t) => t.amount_cents < 0).sort((a, b) => a.date.localeCompare(b.date));
  const inflows = contributionTxs.filter((t) => t.amount_cents > 0).sort((a, b) => a.date.localeCompare(b.date));
  const usedInflows = new Set<number>();

  const daysBetween = (from: string, to: string): number =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

  const candidateCombos = (items: Array<{ tx: TransferTransaction; index: number }>) => {
    const combos: Array<{ indexes: number[]; amount: number; maxDays: number }> = [];
    const walk = (start: number, picked: number[], amount: number, maxDays: number) => {
      if (picked.length > 0) combos.push({ indexes: [...picked], amount, maxDays });
      if (picked.length >= 3) return;
      for (let i = start; i < items.length; i++) {
        picked.push(items[i]!.index);
        walk(i + 1, picked, amount + items[i]!.tx.amount_cents, Math.max(maxDays, daysBetween(items[0]!.tx.date, items[i]!.tx.date)));
        picked.pop();
      }
    };
    walk(0, [], 0, 0);
    return combos;
  };

  for (const outflow of outflows) {
    const target = -outflow.amount_cents;
    const candidates = inflows
      .map((tx, index) => ({ tx, index }))
      .filter(({ tx, index }) => {
        if (usedInflows.has(index) || tx.account_id === outflow.account_id) return false;
        const days = daysBetween(outflow.date, tx.date);
        return days >= 0 && days <= 7;
      });
    if (candidates.length === 0) continue;

    const match = candidateCombos(candidates)
      .filter((c) => c.amount >= target * 0.95 && c.amount <= target * 1.05)
      .sort((a, b) => Math.abs(a.amount - target) - Math.abs(b.amount - target) || a.indexes.length - b.indexes.length || a.maxDays - b.maxDays)[0];
    if (!match) continue;

    const sourceBalance = balanceBefore(outflow.account_id, outflow.month);
    if (sourceBalance <= 0) continue;
    const sourceBasis = basisThrough(outflow.account_id, outflow.month);
    const basisRatio = Math.max(0, Math.min(1, sourceBasis / sourceBalance));
    const basisCarried = Math.round(match.amount * basisRatio);
    const gainsCarried = match.amount - basisCarried;
    if (gainsCarried === 0) continue;

    const matchedInflows = match.indexes.map((index) => inflows[index]!);
    const linkId = `cash:${outflow.id}->${matchedInflows.map((tx) => tx.id).join("+")}`;
    links.push({
      id: linkId,
      reason: "cash-transfer",
      source_account_id: outflow.account_id,
      destination_account_id: matchedInflows[0]!.account_id,
      source_transaction_ids: [outflow.id],
      destination_transaction_ids: matchedInflows.map((tx) => tx.id),
      amount_cents: match.amount,
      basis_cents: basisCarried,
      gains_cents: gainsCarried,
    });

    addAdjustment({
      link_id: linkId,
      reason: "cash-transfer",
      account_id: outflow.account_id,
      month: outflow.month,
      contributions_cents: gainsCarried,
      gains_cents: -gainsCarried,
    });

    let distributedGains = 0;
    for (let i = 0; i < match.indexes.length; i++) {
      const index = match.indexes[i]!;
      usedInflows.add(index);
      const tx = inflows[index]!;
      const txGains = i < match.indexes.length - 1
        ? Math.round(gainsCarried * (tx.amount_cents / match.amount))
        : gainsCarried - distributedGains;
      distributedGains += txGains;
      addAdjustment({
        link_id: linkId,
        reason: "cash-transfer",
        account_id: tx.account_id,
        month: tx.month,
        contributions_cents: -txGains,
        gains_cents: txGains,
      });
    }
  }

  return { links, adjustments };
}
