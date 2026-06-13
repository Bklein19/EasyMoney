import React, { useEffect, useMemo, useState } from "react";

interface TransferAuditAccount {
  id: number;
  name: string;
  institution: string;
  type: string;
}

interface TransferAuditTransaction {
  id: string;
  date: string;
  account_id: number;
  amount_cents: number;
  description: string;
  account: TransferAuditAccount;
}

interface TransferAuditLink {
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

interface TransferAuditCandidate {
  transaction: TransferAuditTransaction;
  direction: "inflow" | "outflow";
  nearby_count: number;
  nearest_days: number | null;
}

interface TransferAuditReport {
  links: TransferAuditLink[];
  unmatched_candidates: TransferAuditCandidate[];
}

const fmtUsd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const accountName = (account: TransferAuditAccount) => `${account.institution} · ${account.name}`;

function TransactionStack({ transactions }: { transactions: TransferAuditTransaction[] }) {
  if (transactions.length === 0) {
    return <div className="transfer-empty">No transaction row; inferred from starting balance.</div>;
  }
  return (
    <div className="transfer-tx-stack">
      {transactions.map((tx) => (
        <div key={tx.id} className="transfer-tx">
          <div className="transfer-tx-top">
            <span>{tx.date}</span>
            <strong>{fmtUsd(tx.amount_cents)}</strong>
          </div>
          <div className="transfer-tx-desc">{tx.description}</div>
        </div>
      ))}
    </div>
  );
}

export function TransfersPage() {
  const [report, setReport] = useState<TransferAuditReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/transfers")
      .then((r) => r.json())
      .then((data) => setReport(data as TransferAuditReport))
      .catch((e) => setError(String(e)));
  }, []);

  const totals = useMemo(() => {
    const links = report?.links ?? [];
    return {
      count: links.length,
      amount: links.reduce((sum, link) => sum + link.amount_cents, 0),
      carriedGains: links.reduce((sum, link) => sum + link.gains_cents, 0),
      unmatched: report?.unmatched_candidates.length ?? 0,
    };
  }, [report]);

  if (error) return <div className="page page-wide"><div className="meta import-error">{error}</div></div>;
  if (!report) return <div className="page page-wide"><div className="empty-state">Loading…</div></div>;

  return (
    <div className="page page-transfers">
      <div className="chart-section-header returns-header">
        <div>
          <div className="chart-title">Transfers</div>
          <div className="chart-subtitle">Audit heuristic links and unmatched transfer-like transactions</div>
        </div>
      </div>

      <div className="totals-row transfer-summary-row">
        <div className="total-card total-card-highlight">
          <div className="total-label">Detected links</div>
          <div className="total-value">{totals.count}</div>
        </div>
        <div className="total-card">
          <div className="total-label">Linked amount</div>
          <div className="total-value">{fmtUsd(totals.amount)}</div>
        </div>
        <div className="total-card">
          <div className="total-label">Gains carried</div>
          <div className="total-value">{fmtUsd(totals.carriedGains)}</div>
        </div>
        <div className="total-card">
          <div className="total-label">Needs review</div>
          <div className="total-value">{totals.unmatched}</div>
        </div>
      </div>

      <div className="return-subsection-title">Detected Links</div>
      <div className="returns-table-wrap transfer-table-wrap">
        <table className="returns-table transfer-table">
          <thead>
            <tr>
              <th>Link</th>
              <th>Outflow</th>
              <th>Inflow</th>
              <th className="num">Amount</th>
              <th className="num">Basis</th>
              <th className="num">Gains</th>
            </tr>
          </thead>
          <tbody>
            {report.links.map((link) => (
              <tr key={link.id}>
                <td>
                  <div className="return-account">{link.reason === "cash-transfer" ? "Cash transfer" : "Starting balance"}</div>
                  <div className={`transfer-confidence ${link.confidence}`}>{link.confidence} confidence</div>
                  <div className="return-meta">{link.explanation}</div>
                </td>
                <td>
                  <div className="transfer-account">{accountName(link.source_account)}</div>
                  <TransactionStack transactions={link.source_transactions} />
                </td>
                <td>
                  <div className="transfer-account">{accountName(link.destination_account)}</div>
                  <TransactionStack transactions={link.destination_transactions} />
                </td>
                <td className="num">{fmtUsd(link.amount_cents)}</td>
                <td className="num">{fmtUsd(link.basis_cents)}</td>
                <td className="num">{fmtUsd(link.gains_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="return-subsection-title">Unmatched Large Transfer-Like Transactions</div>
      <div className="returns-table-wrap transfer-table-wrap">
        <table className="returns-table transfer-candidate-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Account</th>
              <th>Description</th>
              <th className="num">Amount</th>
              <th className="num">Nearby opposites</th>
            </tr>
          </thead>
          <tbody>
            {report.unmatched_candidates.map((candidate) => (
              <tr key={candidate.transaction.id}>
                <td>{candidate.transaction.date}</td>
                <td>
                  <div className="transfer-account">{accountName(candidate.transaction.account)}</div>
                  <div className={`transfer-direction ${candidate.direction}`}>{candidate.direction}</div>
                </td>
                <td>{candidate.transaction.description}</td>
                <td className="num">{fmtUsd(candidate.transaction.amount_cents)}</td>
                <td className="num">
                  {candidate.nearby_count === 0
                    ? "—"
                    : `${candidate.nearby_count} within ${candidate.nearest_days}d`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
