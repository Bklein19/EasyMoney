import React, { useEffect, useState, useCallback, useRef } from "react";

// A pending undo: a message to show and the action that reverses the last mutation.
interface PendingUndo {
  message: string;
  undo: () => Promise<void>;
}

// Toast with an Undo button. Auto-dismisses after `timeoutMs`; clicking Undo runs
// the reverse action. Used for destructive manual-fact edits (alias/balance deletes).
function UndoToast({ pending, onClose }: { pending: PendingUndo; onClose: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    timer.current = setTimeout(onClose, 8000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [pending, onClose]);
  return (
    <div className="undo-toast">
      <span>{pending.message}</span>
      <button
        onClick={async () => {
          if (timer.current) clearTimeout(timer.current);
          await pending.undo();
          onClose();
        }}
      >
        Undo
      </button>
    </div>
  );
}

interface Account {
  id: number;
  name: string;
  institution: string;
  type: string;
  classification: string;
  tax_treatment: string;
  flow_treatment: string;
  account_holder: string | null;
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

interface Alias {
  account_id: number;
  institution: string;
  alias: string;
}

const TYPES = ["checking", "savings", "brokerage", "retirement", "credit-card", "loan", "unknown"];
const CLASSIFICATIONS = ["asset", "liability"];
const TAX_TREATMENTS = ["taxable", "traditional", "roth", "hsa", "none"];
const FLOW_TREATMENTS = ["normal", "contributions"];

function Field({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

// Free-text field that saves on blur or Enter; empty string clears the value (null).
function TextField({ label, value, placeholder, onSave }: {
  label: string; value: string | null; placeholder?: string; onSave: (v: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => { setDraft(value ?? ""); }, [value]);
  const commit = () => {
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next !== (value ?? null)) onSave(next);
  };
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      />
    </div>
  );
}

function AccountNameField({ account, onSave }: { account: Account; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(account.name);
  const [status, setStatus] = useState<"idle" | "dirty" | "saving" | "saved">("idle");

  useEffect(() => {
    setName(account.name);
    setStatus("idle");
  }, [account.name]);

  const save = async () => {
    const next = name.trim();
    if (!next || next === account.name) {
      setName(account.name);
      setStatus("idle");
      return;
    }
    setStatus("saving");
    await onSave(next);
    setStatus("saved");
  };
  const isDirty = name.trim() !== account.name;

  return (
    <div className="account-name-row">
      <div className="field account-name-field">
        <label>Name</label>
        <input
          type="text"
          value={name}
          disabled={status === "saving"}
          onChange={(e) => {
            setName(e.target.value);
            setStatus("dirty");
          }}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setName(account.name);
              setStatus("idle");
              e.currentTarget.blur();
            }
          }}
        />
      </div>
      <div className={`account-name-status ${status}`}>
        {status === "saving" ? "Saving" : isDirty ? "Unsaved" : status === "saved" ? "Saved" : "Autosaves"}
      </div>
    </div>
  );
}

function AccountMetaForm({ account, aliases, onSaved, onUndo }: {
  account: Account; aliases: Alias[]; onSaved: () => void; onUndo: (p: PendingUndo) => void;
}) {
  const patch = async (edit: Record<string, string | null>) => {
    await fetch(`/api/accounts/${account.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edit),
    });
    onSaved();
  };
  const deleteAlias = async (institution: string, alias: string) => {
    await fetch("/api/accounts/alias", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ institution, alias }),
    });
    onSaved();
    onUndo({
      message: `Removed alias "${alias}"`,
      undo: async () => {
        await fetch("/api/accounts/alias", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ institution, alias, account_id: account.id }),
        });
        onSaved();
      },
    });
  };
  return (
    <div className="account-details-block">
      <div className="manual-entries-title">Account details</div>
      <div className="meta-form">
        <AccountNameField account={account} onSave={(name) => patch({ name })} />
        <Field label="Type" value={account.type} options={TYPES} onChange={(v) => patch({ type: v })} />
        <Field label="Class" value={account.classification} options={CLASSIFICATIONS} onChange={(v) => patch({ classification: v })} />
        <Field label="Tax" value={account.tax_treatment} options={TAX_TREATMENTS} onChange={(v) => patch({ tax_treatment: v })} />
        <Field
          label="Flow treatment"
          value={account.flow_treatment}
          options={FLOW_TREATMENTS}
          onChange={(v) => patch({ flow_treatment: v })}
        />
        <TextField
          label="Holder"
          value={account.account_holder}
          placeholder="e.g. Annie"
          onSave={(v) => patch({ account_holder: v })}
        />
      </div>
      {aliases.length > 0 && (
        <div className="aliases-block">
          <div className="manual-entries-title">
            Aliases <span style={{ color: "var(--text-faint)" }}>(parser-emitted strings mapped to this account)</span>
          </div>
          <div className="alias-chips">
            {aliases.map((al) => (
              <span key={al.alias} className="alias-chip">
                {al.alias}
                <button title="Remove alias" onClick={() => deleteAlias(al.institution, al.alias)}>✕</button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
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
    <div className="override-form">
      <div className="field">
        <label>As of</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="field">
        <label>Balance</label>
        <input
          type="text"
          placeholder="12,345.67"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          style={{ width: 130 }}
        />
      </div>
      <div className="field" style={{ flex: 1, minWidth: 140 }}>
        <label>Note</label>
        <input
          type="text"
          placeholder="optional"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <button className="btn-primary" onClick={save} disabled={saving || !amount}>
        Save
      </button>
      <button className="btn-subtle" onClick={markClosed} disabled={saving}>
        Mark closed
      </button>
    </div>
  );
}

export function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [manualBalances, setManualBalances] = useState<ManualBalance[]>([]);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);

  const reload = useCallback(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data: { accounts: Account[]; manualBalances: ManualBalance[]; aliases: Alias[] }) => {
        setAccounts(data.accounts);
        setManualBalances(data.manualBalances);
        setAliases(data.aliases ?? []);
        setLoading(false);
      });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const deleteManual = async (m: ManualBalance) => {
    await fetch("/api/accounts/manual-balance", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: m.id }),
    });
    reload();
    setPendingUndo({
      message: `Removed manual balance ${fmtUsd(m.balance_cents / 100)} on ${m.date}`,
      undo: async () => {
        await fetch("/api/accounts/manual-balance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_id: m.account_id, date: m.date, balance_cents: m.balance_cents, note: m.note }),
        });
        reload();
      },
    });
  };

  if (loading) return <div className="page page-accounts"><div className="empty-state">Loading…</div></div>;

  const total = accounts.reduce((sum, a) => sum + (a.latest_balance_cents ?? 0), 0);

  return (
    <div className="page page-accounts">
      <h2 className="page-title">
        Accounts <span className="count">{accounts.length} · {fmtUsd(total / 100)}</span>
      </h2>
      <table className="accounts-table">
        <colgroup>
          <col className="c-account" />
          <col className="c-type" />
          <col className="c-tax" />
          <col className="c-balance" />
          <col className="c-asof" />
          <col className="c-action" />
        </colgroup>
        <thead>
          <tr>
            <th>Account</th>
            <th>Type</th>
            <th>Tax</th>
            <th className="num">Balance</th>
            <th>As of</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => {
            const accountManual = manualBalances.filter((m) => m.account_id === a.id);
            const isExpanded = expanded === a.id;
            const isClosed = a.latest_balance_cents === 0;
            return (
              <React.Fragment key={a.id}>
                <tr
                  className={`${isClosed && !isExpanded ? "closed " : ""}account-row${isExpanded ? " expanded" : ""}`}
                  onClick={() => setExpanded(isExpanded ? null : a.id)}
                >
                  <td>
                    <div className="acct-name" title={a.name}>
                      <span className="name-text">{a.name}</span>
                      {isClosed && <span className="closed-badge">closed</span>}
                    </div>
                    <div className="acct-institution">
                      {a.institution}
                      {a.account_holder && <span className="acct-holder">{a.account_holder}</span>}
                    </div>
                  </td>
                  <td><span className="acct-chip">{a.type}</span></td>
                  <td><span className="acct-chip">{a.tax_treatment}</span></td>
                  <td className={`acct-balance${isClosed ? " zero" : ""}`}>
                    {a.latest_balance_cents !== null ? fmtUsd(a.latest_balance_cents / 100) : "—"}
                  </td>
                  <td className="acct-asof">{a.latest_balance_date ?? "—"}</td>
                  <td className="acct-disclosure">
                    <span>{isExpanded ? "Close" : "Edit"}</span>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="expanded-row">
                    <td colSpan={6} style={{ padding: "4px 0 12px", borderBottom: "1px solid var(--border-subtle)" }}>
                      <div className="override-panel">
                        <AccountMetaForm
                          account={a}
                          aliases={aliases.filter((al) => al.account_id === a.id)}
                          onSaved={reload}
                          onUndo={setPendingUndo}
                        />
                        <div className="override-divider" />
                        <div className="manual-entries-title">Manual balance adjustment</div>
                        <AddBalanceForm account={a} onSaved={reload} />
                        {accountManual.length > 0 && (
                          <div className="manual-entries">
                            <div className="manual-entries-title">Manual entries</div>
                            {accountManual.map((m) => (
                              <div key={m.id} className="manual-entry">
                                <span className="amount">{fmtUsd(m.balance_cents / 100)}</span>
                                <span>{m.date}</span>
                                {m.note && <span className="note">{m.note}</span>}
                                <button className="delete" onClick={() => deleteManual(m)} title="Delete entry">
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {pendingUndo && <UndoToast pending={pendingUndo} onClose={() => setPendingUndo(null)} />}
    </div>
  );
}
