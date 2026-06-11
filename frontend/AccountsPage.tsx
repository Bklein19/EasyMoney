import React, { useEffect, useState, useCallback } from "react";

interface Account {
  id: number;
  name: string;
  institution: string;
  type: string;
  classification: string;
  tax_treatment: string;
  latest_balance_cents: number | null;
  latest_balance_date: string | null;
}

interface ManualBalance {
  id: number;
  account_id: number;
  date: string;
  balance_cents: number;
  note: string | null;
}

const fmtUsd = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function AddBalanceForm({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const dollars = parseFloat(amount.replace(/[^0-9.-]/g, ""));
    if (isNaN(dollars)) return;
    setSaving(true);
    await fetch("/api/accounts/manual-balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: account.id,
        date,
        balance_cents: Math.round(dollars * 100),
        note: note || null,
      }),
    });
    setSaving(false);
    setAmount("");
    setNote("");
    onSaved();
  };

  const markClosed = async () => {
    setSaving(true);
    await fetch("/api/accounts/manual-balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: account.id,
        date,
        balance_cents: 0,
        note: "Account closed",
      }),
    });
    setSaving(false);
    onSaved();
  };

  return (
    <div className="add-balance-form">
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        style={{ background: "#1a1a1a", border: "1px solid #333", color: "#e8e8e8", padding: "4px 8px", borderRadius: 4, fontSize: 13 }}
      />
      <input
        type="text"
        placeholder="Balance (e.g. 12345.67)"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
        style={{ background: "#1a1a1a", border: "1px solid #333", color: "#e8e8e8", padding: "4px 8px", borderRadius: 4, fontSize: 13, width: 160 }}
      />
      <input
        type="text"
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        style={{ background: "#1a1a1a", border: "1px solid #333", color: "#e8e8e8", padding: "4px 8px", borderRadius: 4, fontSize: 13, width: 180 }}
      />
      <button
        onClick={save}
        disabled={saving || !amount}
        style={{ background: "#2a4a8a", border: "none", color: "#e8e8e8", padding: "4px 12px", borderRadius: 4, fontSize: 13, cursor: "pointer" }}
      >
        Save
      </button>
      <button
        onClick={markClosed}
        disabled={saving}
        style={{ background: "#333", border: "none", color: "#888", padding: "4px 12px", borderRadius: 4, fontSize: 13, cursor: "pointer" }}
      >
        Mark closed ($0)
      </button>
    </div>
  );
}

export function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [manualBalances, setManualBalances] = useState<ManualBalance[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data: { accounts: Account[]; manualBalances: ManualBalance[] }) => {
        setAccounts(data.accounts);
        setManualBalances(data.manualBalances);
        setLoading(false);
      });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const deleteManual = async (id: number) => {
    await fetch("/api/accounts/manual-balance", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    reload();
  };

  if (loading) return <div className="page"><p style={{ color: "#888" }}>Loading...</p></div>;

  return (
    <div className="page">
      <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 18, fontWeight: 600 }}>
        Accounts <span style={{ color: "#888", fontWeight: 400, fontSize: 14 }}>({accounts.length})</span>
      </h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #333", color: "#888", textAlign: "left" }}>
            <th style={{ padding: "6px 12px 6px 0", fontWeight: 500 }}>Account</th>
            <th style={{ padding: "6px 12px", fontWeight: 500 }}>Type</th>
            <th style={{ padding: "6px 12px", fontWeight: 500 }}>Tax</th>
            <th style={{ padding: "6px 12px", fontWeight: 500, textAlign: "right" }}>Latest balance</th>
            <th style={{ padding: "6px 12px", fontWeight: 500 }}>As of</th>
            <th style={{ padding: "6px 12px", fontWeight: 500 }}></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => {
            const accountManual = manualBalances.filter((m) => m.account_id === a.id);
            const isExpanded = expanded === a.id;
            return (
              <React.Fragment key={a.id}>
                <tr style={{ borderBottom: "1px solid #1e1e1e" }}>
                  <td style={{ padding: "8px 12px 8px 0" }}>
                    <div style={{ color: "#e8e8e8" }}>{a.name}</div>
                    <div style={{ color: "#555", fontSize: 11 }}>{a.institution}</div>
                  </td>
                  <td style={{ padding: "8px 12px", color: "#888" }}>{a.type}</td>
                  <td style={{ padding: "8px 12px", color: "#888" }}>{a.tax_treatment}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: a.latest_balance_cents === 0 ? "#555" : "#e8e8e8" }}>
                    {a.latest_balance_cents !== null ? fmtUsd(a.latest_balance_cents / 100) : "—"}
                  </td>
                  <td style={{ padding: "8px 12px", color: "#555", fontSize: 12 }}>{a.latest_balance_date ?? "—"}</td>
                  <td style={{ padding: "8px 12px" }}>
                    <button
                      onClick={() => setExpanded(isExpanded ? null : a.id)}
                      style={{ background: "none", border: "1px solid #333", color: "#888", padding: "2px 8px", borderRadius: 4, fontSize: 12, cursor: "pointer" }}
                    >
                      {isExpanded ? "▲" : "▼"} override
                    </button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr style={{ borderBottom: "1px solid #222", background: "#111" }}>
                    <td colSpan={6} style={{ padding: "12px 0 12px 16px" }}>
                      <div style={{ marginBottom: 10 }}>
                        <AddBalanceForm account={a} onSaved={reload} />
                      </div>
                      {accountManual.length > 0 && (
                        <div>
                          <div style={{ color: "#555", fontSize: 11, marginBottom: 6 }}>Manual entries</div>
                          {accountManual.map((m) => (
                            <div key={m.id} style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 12, color: "#888", marginBottom: 4 }}>
                              <span style={{ color: "#e8e8e8" }}>{fmtUsd(m.balance_cents / 100)}</span>
                              <span>{m.date}</span>
                              {m.note && <span style={{ color: "#555" }}>{m.note}</span>}
                              <button
                                onClick={() => deleteManual(m.id)}
                                style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 11, padding: "0 4px" }}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
