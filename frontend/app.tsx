import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportsPage } from "./ImportsPage";
import { NetWorthPage } from "./NetWorthPage";
import { SavingsRatePage } from "./SavingsRatePage";
import { AccountsPage } from "./Accounts";
import "./styles.css";

type Page = "imports" | "networth" | "performance" | "savings" | "accounts";

const PAGES: Page[] = ["imports", "networth", "performance", "savings", "accounts"];

const NAV: Array<{ id: Page; label: string; icon: string }> = [
  { id: "imports", label: "Imports", icon: "≡" },
  { id: "networth", label: "Net Worth", icon: "◆" },
  { id: "performance", label: "Performance", icon: "↗" },
  { id: "savings", label: "Savings Rate", icon: "◫" },
  { id: "accounts", label: "Accounts", icon: "⊞" },
];

function getPageFromHash(): Page {
  const rawHash = location.hash.slice(1);
  const hash = (rawHash === "import" ? "imports" : rawHash) as Page;
  return PAGES.includes(hash) ? hash : "networth";
}

function App() {
  const [page, setPage] = useState<Page>(getPageFromHash);

  useEffect(() => {
    const handler = () => setPage(getPageFromHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const navigate = (id: Page) => {
    location.hash = id;
    setPage(id);
  };

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar-title">Observatory</div>
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
      </nav>
      <main className="main">
        {page === "imports" && <ImportsPage />}
        {page === "networth" && <NetWorthPage view="networth" />}
        {page === "performance" && <NetWorthPage view="performance" />}
        {page === "savings" && <SavingsRatePage />}
        {page === "accounts" && <AccountsPage />}
      </main>
    </div>
  );
}

const root = createRoot(document.body);
root.render(<App />);
