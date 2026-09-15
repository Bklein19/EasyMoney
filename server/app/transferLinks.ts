import { classifyFlow } from './flowClassification.ts';
import type { ConfirmedTransferRecord } from './transferRecords.ts';

export interface AccountTransferSeed {
  account_id: number;
  firstMonth: string | null;
  startingAmount: number;
  contributionAdjustments: Map<string, number>;
  gainsByMonth?: Map<string, number>;
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
  reason: 'starting-balance-transfer' | 'cash-transfer' | 'reporting-closure';
  account_id: number;
  month: string;
  contributions_cents: number;
  gains_cents: number;
}

export interface TransferLink {
  id: string;
  reason: TransferAdjustment['reason'];
  confirmation: 'inferred' | 'confirmed';
  evidence_status: 'inferred' | 'awaiting-bank-records' | 'matched' | 'conflict';
  effective_date: string;
  source_account_id: number;
  destination_account_id: number | null;
  source_transaction_ids: string[];
  destination_transaction_ids: string[];
  amount_cents: number | null;
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
  accounts: Array<{ id: number; type?: string }>;
  sortedMonths: string[];
  flows: Map<string, FlowTotals>;
  balances: Map<string, number>;
  seeds: Map<number, AccountTransferSeed>;
  transactions: TransferTransaction[];
  confirmedTransfers?: ConfirmedTransferRecord[];
}): TransferDerivation {
  const flowKey = (month: string, accountId: number) => `${month}|${accountId}`;
  const monthBefore = (month: string) => input.sortedMonths[input.sortedMonths.indexOf(month) - 1] ?? null;
  const links: TransferLink[] = [];
  const adjustments: TransferAdjustment[] = [];
  const accountType = new Map(input.accounts.map((account) => [account.id, account.type ?? 'unknown']));
  const canCarryMarketGains = (accountId: number): boolean =>
    !['checking', 'savings', 'credit-card', 'loan'].includes(accountType.get(accountId) ?? 'unknown');

  const contributionAdjustments = new Map<number, Map<string, number>>();
  const gainsAdjustments = new Map<number, Map<string, number>>();
  for (const seed of input.seeds.values()) {
    contributionAdjustments.set(seed.account_id, new Map(seed.contributionAdjustments));
    gainsAdjustments.set(seed.account_id, new Map());
  }

  const addAdjustment = (adjustment: TransferAdjustment) => {
    adjustments.push(adjustment);
    const contribution = contributionAdjustments.get(adjustment.account_id) ?? new Map<string, number>();
    contribution.set(adjustment.month, (contribution.get(adjustment.month) ?? 0) + adjustment.contributions_cents);
    contributionAdjustments.set(adjustment.account_id, contribution);

    const gains = gainsAdjustments.get(adjustment.account_id) ?? new Map<string, number>();
    gains.set(adjustment.month, (gains.get(adjustment.month) ?? 0) + adjustment.gains_cents);
    gainsAdjustments.set(adjustment.account_id, gains);
  };

  const basisThrough = (accountId: number, beforeMonth: string): number => {
    let cumulative = 0;
    const accountAdjustments = contributionAdjustments.get(accountId);
    for (const month of input.sortedMonths) {
      if (month >= beforeMonth) break;
      const flow = input.flows.get(flowKey(month, accountId));
      cumulative += (flow?.contributions ?? 0) + (accountAdjustments?.get(month) ?? 0);
      if (cumulative < 0) cumulative = 0;
    }
    return cumulative;
  };

  const balanceBefore = (accountId: number, beforeMonth: string): number => {
    let latest = 0;
    for (const month of input.sortedMonths) {
      if (month >= beforeMonth) break;
      const balance = input.balances.get(flowKey(month, accountId));
      if (balance !== undefined) latest = balance;
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
        const outflow = input.flows.get(flowKey(month, other.id))?.contributions ?? 0;
        if (outflow < 0 && Math.abs(outflow) >= seed.startingAmount * 0.95 && Math.abs(outflow) <= seed.startingAmount * 1.05) {
          candidates.push({ id: other.id, outflowMonth: month });
          break;
        }
      }
    }
    if (candidates.length !== 1) continue;

    const source = candidates[0]!;
    const sourceBasis = basisThrough(source.id, source.outflowMonth);
    const basisCarried = canCarryMarketGains(source.id) ? Math.min(seed.startingAmount, sourceBasis) : seed.startingAmount;
    const gainsCarried = seed.startingAmount - basisCarried;
    const sourceOutflow = input.flows.get(flowKey(source.outflowMonth, source.id))?.contributions ?? 0;
    const sourceBasisPart = canCarryMarketGains(source.id) ? -Math.min(-sourceOutflow, sourceBasis) : sourceOutflow;
    const sourceGainsPart = sourceOutflow - sourceBasisPart;
    const linkId = `starting:${source.id}:${source.outflowMonth}->${account.id}:${seed.firstMonth}`;

    links.push({
      id: linkId,
      reason: 'starting-balance-transfer',
      confirmation: 'inferred', evidence_status: 'inferred', effective_date: `${source.outflowMonth}-01`,
      source_account_id: source.id,
      destination_account_id: account.id,
      source_transaction_ids: [],
      destination_transaction_ids: [],
      amount_cents: seed.startingAmount,
      basis_cents: basisCarried,
      gains_cents: gainsCarried,
    });

    if (canCarryMarketGains(account.id)) {
      addAdjustment({
        link_id: linkId,
        reason: 'starting-balance-transfer',
        account_id: account.id,
        month: seed.firstMonth,
        contributions_cents: basisCarried - seed.startingAmount,
        gains_cents: gainsCarried,
      });
    }
    if (sourceGainsPart !== 0) {
      addAdjustment({
        link_id: linkId,
        reason: 'starting-balance-transfer',
        account_id: source.id,
        month: source.outflowMonth,
        contributions_cents: -sourceGainsPart,
        gains_cents: sourceGainsPart,
      });
    }
  }

  const contributionTxs = input.transactions.filter(
    (transaction) => classifyFlow(transaction.description) === 'contribution' && Math.abs(transaction.amount_cents) >= 1_000_000
  );
  const outflows = contributionTxs.filter((transaction) => transaction.amount_cents < 0).sort((a, b) => a.date.localeCompare(b.date));
  const inflows = contributionTxs.filter((transaction) => transaction.amount_cents > 0).sort((a, b) => a.date.localeCompare(b.date));
  const usedInflows = new Set<number>();

  const daysBetween = (from: string, to: string): number =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

  const candidateCombos = (items: Array<{ tx: TransferTransaction; index: number }>) => {
    const combos: Array<{ indexes: number[]; amount: number; maxDays: number }> = [];
    const walk = (start: number, picked: number[], amount: number, maxDays: number) => {
      if (picked.length > 0) combos.push({ indexes: [...picked], amount, maxDays });
      if (picked.length >= 3) return;
      for (let index = start; index < items.length; index += 1) {
        picked.push(items[index]!.index);
        walk(
          index + 1,
          picked,
          amount + items[index]!.tx.amount_cents,
          Math.max(maxDays, daysBetween(items[0]!.tx.date, items[index]!.tx.date))
        );
        picked.pop();
      }
    };
    walk(0, [], 0, 0);
    return combos;
  };

  for (const outflow of outflows) {
    const target = -outflow.amount_cents;
    const candidates = inflows
      .map((transaction, index) => ({ tx: transaction, index }))
      .filter(({ tx, index }) => {
        if (usedInflows.has(index) || tx.account_id === outflow.account_id) return false;
        const days = daysBetween(outflow.date, tx.date);
        return days >= 0 && days <= 7;
      });
    if (candidates.length === 0) continue;

    const match = candidateCombos(candidates)
      .filter((candidate) => candidate.amount >= target * 0.95 && candidate.amount <= target * 1.05)
      .sort((a, b) => Math.abs(a.amount - target) - Math.abs(b.amount - target) || a.indexes.length - b.indexes.length || a.maxDays - b.maxDays)[0];
    if (!match) continue;

    const sourceBalance = balanceBefore(outflow.account_id, outflow.month);
    if (sourceBalance <= 0) continue;
    const sourceBasis = basisThrough(outflow.account_id, outflow.month);
    const basisRatio = canCarryMarketGains(outflow.account_id) ? Math.max(0, Math.min(1, sourceBasis / sourceBalance)) : 1;
    const basisCarried = Math.round(match.amount * basisRatio);
    const gainsCarried = match.amount - basisCarried;

    const matchedInflows = match.indexes.map((index) => inflows[index]!);
    const linkId = `cash:${outflow.id}->${matchedInflows.map((transaction) => transaction.id).join('+')}`;
    links.push({
      id: linkId,
      reason: 'cash-transfer',
      confirmation: 'inferred', evidence_status: 'inferred', effective_date: outflow.date,
      source_account_id: outflow.account_id,
      destination_account_id: matchedInflows[0]!.account_id,
      source_transaction_ids: [outflow.id],
      destination_transaction_ids: matchedInflows.map((transaction) => transaction.id),
      amount_cents: match.amount,
      basis_cents: basisCarried,
      gains_cents: gainsCarried,
    });

    addAdjustment({
      link_id: linkId,
      reason: 'cash-transfer',
      account_id: outflow.account_id,
      month: outflow.month,
      contributions_cents: gainsCarried,
      gains_cents: -gainsCarried,
    });

    let distributedGains = 0;
    for (let index = 0; index < match.indexes.length; index += 1) {
      const inflowIndex = match.indexes[index]!;
      usedInflows.add(inflowIndex);
      const transaction = inflows[inflowIndex]!;
      const transactionGains = index < match.indexes.length - 1
        ? Math.round(gainsCarried * (transaction.amount_cents / match.amount))
        : gainsCarried - distributedGains;
      distributedGains += transactionGains;
      if (canCarryMarketGains(transaction.account_id)) {
        addAdjustment({
          link_id: linkId,
          reason: 'cash-transfer',
          account_id: transaction.account_id,
          month: transaction.month,
          contributions_cents: -transactionGains,
          gains_cents: transactionGains,
        });
      }
    }
  }

  // Confirmed and inferred records resolve here, before reporting consumes any
  // adjustments. A matching bank record enriches the stable confirmed record;
  // it does not create another economic transfer or another adjustment.
  for (const record of [...(input.confirmedTransfers ?? [])].sort((a,b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id))) {
    const month = record.effectiveDate.slice(0,7);
    const matches = links.filter(link => link.source_account_id === record.sourceAccountId &&
      link.destination_account_id === record.destinationAccountId &&
      (link.reason === 'starting-balance-transfer'
        ? link.effective_date.slice(0,7) === month
        : Math.abs(daysBetween(link.effective_date, record.effectiveDate)) <= 7));
    if (matches.length === 1) {
      const matched = matches[0]!;
      const previousId = matched.id;
      matched.id = record.id;
      matched.confirmation = 'confirmed';
      matched.evidence_status = 'matched';
      matched.effective_date = record.effectiveDate;
      for (const adjustment of adjustments) if (adjustment.link_id === previousId) adjustment.link_id = record.id;
      continue;
    }
    const conflict = matches.length > 1 || input.balances.get(flowKey(month,record.sourceAccountId)) !== 0;
    const link: TransferLink = {
      id: record.id, reason: record.reason, confirmation: 'confirmed',
      evidence_status: conflict ? 'conflict' : 'awaiting-bank-records', effective_date: record.effectiveDate,
      source_account_id: record.sourceAccountId, destination_account_id: record.destinationAccountId,
      source_transaction_ids: [], destination_transaction_ids: [], amount_cents: null, basis_cents: 0, gains_cents: 0,
    };
    links.push(link);
    if (conflict || !canCarryMarketGains(record.sourceAccountId)) continue;
    let basis = 0, gains = 0;
    for (const m of input.sortedMonths) {
      if (m > month) break;
      const flow = input.flows.get(flowKey(m,record.sourceAccountId));
      basis = Math.max(0,basis + (flow?.contributions ?? 0) + (contributionAdjustments.get(record.sourceAccountId)?.get(m) ?? 0));
      gains += (flow?.dividends ?? 0) + (flow?.interest ?? 0) + (input.seeds.get(record.sourceAccountId)?.gainsByMonth?.get(m) ?? 0) + (gainsAdjustments.get(record.sourceAccountId)?.get(m) ?? 0);
    }
    link.basis_cents = basis;
    link.gains_cents = gains;
    addAdjustment({link_id:record.id,reason:record.reason,account_id:record.sourceAccountId,month,contributions_cents:-basis,gains_cents:-gains});
    if (record.destinationAccountId !== null) {
      addAdjustment({link_id:record.id,reason:record.reason,account_id:record.destinationAccountId,month,contributions_cents:basis,gains_cents:-basis});
    }
  }

  return { links: links.sort((a,b) => a.effective_date.localeCompare(b.effective_date) || a.id.localeCompare(b.id)), adjustments };
}
