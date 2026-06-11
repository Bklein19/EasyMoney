import React, { useEffect, useState } from "react";

interface ImportRecord {
  id: number;
  filename: string;
  status: string;
  parser_id: string | null;
  covered_from: string | null;
  covered_to: string | null;
  imported_at: string;
  transactions_count: number;
  balances_count: number;
  accounts: string[];
}

export function ImportsPage() {
  const [records, setRecords] = useState<ImportRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/imports")
      .then((r) => r.json())
      .then((data) => { setRecords(data); setLoading(false); });
  }, []);

  if (loading) return <div className="page"><p style={{ color: "#888" }}>Loading...</p></div>;

  return (
    <div className="page">
      <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 18, fontWeight: 600 }}>
        Imported files <span style={{ color: "#888", fontWeight: 400, fontSize: 14 }}>({records.length})</span>
      </h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #333", color: "#888", textAlign: "left" }}>
            <th style={{ padding: "6px 12px 6px 0", fontWeight: 500 }}>File</th>
            <th style={{ padding: "6px 12px", fontWeight: 500 }}>Coverage</th>
            <th style={{ padding: "6px 12px", fontWeight: 500 }}>Accounts</th>
            <th style={{ padding: "6px 12px", fontWeight: 500, textAlign: "right" }}>Txns</th>
            <th style={{ padding: "6px 12px", fontWeight: 500, textAlign: "right" }}>Balances</th>
            <th style={{ padding: "6px 12px", fontWeight: 500 }}>Parser</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id} style={{ borderBottom: "1px solid #222" }}>
              <td style={{ padding: "8px 12px 8px 0", maxWidth: 260 }}>
                <span
                  style={{
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: r.status === "ok" ? "#e8e8e8" : "#e05252",
                  }}
                  title={r.filename}
                >
                  {r.filename}
                </span>
                <span style={{ color: "#555", fontSize: 11 }}>
                  {r.imported_at.slice(0, 10)}
                </span>
              </td>
              <td style={{ padding: "8px 12px", color: "#aaa", whiteSpace: "nowrap" }}>
                {r.covered_from && r.covered_to
                  ? r.covered_from === r.covered_to
                    ? r.covered_from
                    : `${r.covered_from} – ${r.covered_to}`
                  : <span style={{ color: "#555" }}>—</span>}
              </td>
              <td style={{ padding: "8px 12px", color: "#aaa", fontSize: 12 }}>
                {r.accounts.length > 0
                  ? r.accounts.join(", ")
                  : <span style={{ color: "#555" }}>—</span>}
              </td>
              <td style={{ padding: "8px 12px", textAlign: "right", color: r.transactions_count > 0 ? "#e8e8e8" : "#555" }}>
                {r.transactions_count || "—"}
              </td>
              <td style={{ padding: "8px 12px", textAlign: "right", color: r.balances_count > 0 ? "#e8e8e8" : "#555" }}>
                {r.balances_count || "—"}
              </td>
              <td style={{ padding: "8px 12px", color: "#666", fontSize: 12, whiteSpace: "nowrap" }}>
                {r.parser_id ?? <span style={{ color: "#444" }}>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
