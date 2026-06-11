import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImportPage } from "./ImportPage";
import { ImportsPage } from "./ImportsPage";
import { NetWorthPage } from "./NetWorthPage";
import "./app.css";

type Page = "import" | "imports" | "networth";

const NAV: Array<{ id: Page; label: string; icon: string }> = [
  { id: "import", label: "Import", icon: "↑" },
  { id: "imports", label: "Imports", icon: "≡" },
  { id: "networth", label: "Net Worth", icon: "◆" },
];

function App() {
  const [page, setPage] = useState<Page>("import");

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar-title">Observatory</div>
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-item${page === item.id ? " active" : ""}`}
            onClick={() => setPage(item.id)}
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
      </main>
    </div>
  );
}

const root = createRoot(document.body);
root.render(<App />);
