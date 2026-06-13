import React, { useEffect, useRef, useState } from "react";
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
  { id: "networth", label: "Net Worth", icon: "◆" },
  { id: "performance", label: "Performance", icon: "↗" },
  { id: "savings", label: "Savings Rate", icon: "◫" },
  { id: "accounts", label: "Accounts", icon: "⊞" },
  { id: "imports", label: "Imports", icon: "≡" },
  { id: "transfers", label: "Transfers", icon: "⇄" },
];

const SIDEBAR_WIDTH_KEY = "money.sidebarWidth";
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 520;

// Pages that filter by account and therefore show the shared picker.
const PICKER_PAGES = new Set<Page>(["networth", "performance", "savings"]);

function getPageFromHash(): Page {
  const rawHash = location.hash.slice(1);
  const hash = (rawHash === "import" ? "imports" : rawHash) as Page;
  return PAGES.includes(hash) ? hash : "networth";
}

function App() {
  const sidebarRef = useRef<HTMLElement | null>(null);
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

  useEffect(() => {
    const savedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (!Number.isFinite(savedWidth) || savedWidth <= 0) return;
    const width = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, savedWidth));
    sidebarRef.current?.style.setProperty("--sidebar-width", `${width}px`);
  }, []);

  const navigate = (id: Page) => {
    location.hash = id;
    setPage(id);
  };

  const startSidebarResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!sidebarRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("sidebar-resizing");
    const left = sidebarRef.current.getBoundingClientRect().left;
    const setWidth = (clientX: number) => {
      if (!sidebarRef.current) return;
      const width = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, clientX - left));
      sidebarRef.current.style.setProperty("--sidebar-width", `${width}px`);
      return width;
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      setWidth(moveEvent.clientX);
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      const width = setWidth(upEvent.clientX);
      if (width) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
      document.body.classList.remove("sidebar-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  // Resolve null → all-selected once accounts are loaded.
  const selectedIds = selected ?? new Set(accounts.map((a) => a.id));

  const showPicker = PICKER_PAGES.has(page) && accounts.length > 0;

  return (
    <div className="layout">
      <nav ref={sidebarRef} className="sidebar">
        <div className="sidebar-scroll">
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
              <div className="sidebar-section-title sidebar-section-title-row">
                <span>Accounts</span>
                <span>{selectedIds.size} of {accounts.length}</span>
              </div>
              <AccountPicker accounts={accounts} selectedIds={selectedIds} onChange={setSelected} />
            </div>
          )}
        </div>
        <div className="sidebar-resize-handle" onPointerDown={startSidebarResize} />
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
