import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportsPage } from "./ImportsPage";
import { NetWorthPage } from "./NetWorthPage";
import { SavingsRatePage } from "./SavingsRatePage";
import { TransfersPage } from "./TransfersPage";
import { AccountsPage } from "./Accounts";
import { AccountPicker, type PickerAccount } from "./AccountPicker";
import "./styles.css";

type Page = "imports" | "networth" | "performance" | "savings" | "transfers" | "accounts";

const PAGES: Page[] = ["imports", "networth", "performance", "savings", "transfers", "accounts"];

const NAV: Array<{ id: Page; label: string; icon: string }> = [
  { id: "imports", label: "Imports", icon: "≡" },
  { id: "networth", label: "Net Worth", icon: "◆" },
  { id: "performance", label: "Performance", icon: "↗" },
  { id: "savings", label: "Savings Rate", icon: "◫" },
  { id: "transfers", label: "Transfers", icon: "⇄" },
  { id: "accounts", label: "Accounts", icon: "⊞" },
];

// Pages that filter by account and therefore show the shared picker.
const PICKER_PAGES = new Set<Page>(["networth", "performance", "savings"]);

function getPageFromHash(): Page {
  const rawHash = location.hash.slice(1);
  const hash = (rawHash === "import" ? "imports" : rawHash) as Page;
  return PAGES.includes(hash) ? hash : "networth";
}

function App() {
  const [page, setPage] = useState<Page>(getPageFromHash);
  const [accounts, setAccounts] = useState<PickerAccount[]>([]);
  // Shared account selection — persists across page switches. null = all selected.
  const [selected, setSelected] = useState<Set<number> | null>(null);

  useEffect(() => {
    const handler = () => setPage(getPageFromHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data: { accounts: PickerAccount[] }) => setAccounts(data.accounts ?? []))
      .catch(() => {});
  }, []);

  const navigate = (id: Page) => {
    location.hash = id;
    setPage(id);
  };

  // Resolve null → all-selected once accounts are loaded.
  const selectedIds = selected ?? new Set(accounts.map((a) => a.id));

  const showPicker = PICKER_PAGES.has(page) && accounts.length > 0;

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar-title">Observatory</div>
        <div className="sidebar-nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item${page === item.id ? " active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
        {showPicker && (
          <div className="sidebar-accounts">
            <div className="sidebar-section-title">Accounts</div>
            <AccountPicker accounts={accounts} selectedIds={selectedIds} onChange={setSelected} />
          </div>
        )}
      </nav>
      <main className="main">
        {page === "imports" && <ImportsPage />}
        {page === "networth" && <NetWorthPage view="networth" selectedIds={selectedIds} />}
        {page === "performance" && <NetWorthPage view="performance" selectedIds={selectedIds} />}
        {page === "savings" && <SavingsRatePage selectedIds={selectedIds} />}
        {page === "transfers" && <TransfersPage />}
        {page === "accounts" && <AccountsPage />}
      </main>
    </div>
  );
}

const root = createRoot(document.body);
root.render(<App />);
