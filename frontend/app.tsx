import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportPage } from "./ImportPage";
import { ImportsPage } from "./ImportsPage";
import { NetWorthPage } from "./NetWorthPage";
import { AccountsPage } from "./Accounts";
import "./styles.css";

type Page = "import" | "imports" | "networth" | "accounts";

const PAGES: Page[] = ["import", "imports", "networth", "accounts"];

const NAV: Array<{ id: Page; label: string; icon: string }> = [
  { id: "import", label: "Import", icon: "↑" },
  { id: "imports", label: "Imports", icon: "≡" },
  { id: "networth", label: "Net Worth", icon: "◆" },
  { id: "accounts", label: "Accounts", icon: "⊞" },
];

function getPageFromHash(): Page {
  const hash = location.hash.slice(1) as Page;
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
        {page === "import" && <ImportPage />}
        {page === "imports" && <ImportsPage />}
        {page === "networth" && <NetWorthPage />}
        {page === "accounts" && <AccountsPage />}
      </main>
    </div>
  );
}

const root = createRoot(document.body);
root.render(<App />);

