import { getDb } from "./db";
import { classifyFlow } from "./flowClassification";
import { getNetWorthReport } from "./networth";

export interface TransferAuditAccount {
  id: number;
  name: string;
  institution: string;
  type: string;
}

export interface TransferAuditTransaction {
  id: string;
  date: string;
  account_id: number;
  amount_cents: number;
  description: string;
  account: TransferAuditAccount;
}

export interface TransferAuditLink {
  id: string;
  reason: "starting-balance-transfer" | "cash-transfer";
  source_account: TransferAuditAccount;
  destination_account: TransferAuditAccount;
  source_transactions: TransferAuditTransaction[];
  destination_transactions: TransferAuditTransaction[];
  amount_cents: number;
  basis_cents: number;
  gains_cents: number;
  confidence: "high" | "medium";
  explanation: string;
}

export interface TransferAuditCandidate {
  transaction: TransferAuditTransaction;
  direction: "inflow" | "outflow";
  nearby_count: number;
  nearest_days: number | null;
}

export interface TransferAuditReport {
  links: TransferAuditLink[];
  unmatched_candidates: TransferAuditCandidate[];
}

interface DbTransaction {
  id: string;
  date: string;
  account_id: number;
  amount_cents: number;
  description: string;
}

const MIN_AUDIT_AMOUNT_CENTS = 1_000_000;

function daysBetween(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000));
}

function looksTransferLike(description: string): boolean {
  const d = description.toLowerCase();
  return (
    classifyFlow(description) === "contribution" ||
    /transfer|funds received|funds paid|fundtransfers|moneyline|investment|online banking/.test(d)
  );
}

export function getTransferAuditReport(): TransferAuditReport {
  const db = getDb();
  const netWorth = getNetWorthReport();
  const accounts = new Map(
    netWorth.accounts.map((account) => [
      account.id,
      { id: account.id, name: account.name, institution: account.institution, type: account.type },
    ]),
  );

  const txs = db
    .query<DbTransaction, []>(
      `SELECT id, date, account_id, amount_cents, description
       FROM transactions
       WHERE account_id IS NOT NULL
       ORDER BY date`
    )
    .all();
  const txById = new Map(txs.map((tx) => [tx.id, tx]));
  const usedIds = new Set<string>();

  const enrichTx = (tx: DbTransaction): TransferAuditTransaction => ({
    ...tx,
    account: accounts.get(tx.account_id)!,
  });

  const links: TransferAuditLink[] = netWorth.transfer_links
    .map((link) => {
      for (const id of link.source_transaction_ids) usedIds.add(id);
      for (const id of link.destination_transaction_ids) usedIds.add(id);

      const source_account = accounts.get(link.source_account_id)!;
      const destination_account = accounts.get(link.destination_account_id)!;
      const source_transactions = link.source_transaction_ids
        .map((id) => txById.get(id))
        .filter((tx): tx is DbTransaction => tx !== undefined)
        .map(enrichTx);
      const destination_transactions = link.destination_transaction_ids
        .map((id) => txById.get(id))
        .filter((tx): tx is DbTransaction => tx !== undefined)
        .map(enrichTx);
      const confidence: TransferAuditLink["confidence"] =
        source_transactions.length > 0 && destination_transactions.length > 0 ? "high" : "medium";
      const explanation =
        link.reason === "cash-transfer"
          ? "Matched one outflow to one or more similar inflows within 7 days."
          : "Matched a new starting balance to a same-month or previous-month outflow.";

      return {
        id: link.id,
        reason: link.reason,
        source_account,
        destination_account,
        source_transactions,
        destination_transactions,
        amount_cents: link.amount_cents,
        basis_cents: link.basis_cents,
        gains_cents: link.gains_cents,
        confidence,
        explanation,
      };
    })
    .sort((a, b) => b.amount_cents - a.amount_cents);

  const transferLikeTxs = txs
    .filter((tx) => !usedIds.has(tx.id))
    .filter((tx) => Math.abs(tx.amount_cents) >= MIN_AUDIT_AMOUNT_CENTS)
    .filter((tx) => looksTransferLike(tx.description))
    .sort((a, b) => b.date.localeCompare(a.date));

  const unmatched_candidates = transferLikeTxs.slice(0, 80).map((tx): TransferAuditCandidate => {
    const opposite = transferLikeTxs
      .filter((other) => other.id !== tx.id && other.account_id !== tx.account_id && Math.sign(other.amount_cents) !== Math.sign(tx.amount_cents))
      .map((other) => daysBetween(tx.date, other.date))
      .filter((days) => days <= 14)
      .sort((a, b) => a - b);
    return {
      transaction: enrichTx(tx),
      direction: tx.amount_cents > 0 ? "inflow" : "outflow",
      nearby_count: opposite.length,
      nearest_days: opposite[0] ?? null,
    };
  });

  return { links, unmatched_candidates };
}
