import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router';
import { Menu } from 'lucide-react';
import ImportPage from './components/import/ImportPage';
import TransactionsPage from './components/transactions/TransactionsPage';
import AccountsPage from './components/accounts/AccountsPage';
import Sidebar from './components/layout/Sidebar';
import AnalyticsPage from './components/analytics/AnalyticsPage';
import BudgetingPage from './components/budgeting/BudgetingPage';
import { NetWorthPage } from './components/investments/NetWorthPage';
import { RetirementPage } from './components/investments/RetirementPage';
import { SavingsRatePage } from './components/investments/SavingsRatePage';
import { subscribeToDataChanges } from './db/api';
import './App.css';

const getInitialSidebarCollapsed = () => {
  try {
    return window.localStorage.getItem('easymoney:sidebar-collapsed') === 'true';
  } catch {
    return false;
  }
};

function App() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(getInitialSidebarCollapsed);
  const [isSidebarPeekOpen, setIsSidebarPeekOpen] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [reportAccounts, setReportAccounts] = useState([]);
  const [selectedReportAccountIds, setSelectedReportAccountIds] = useState(null);

  const handleSidebarCollapsedChange = (nextValue) => {
    setIsSidebarCollapsed(nextValue);
    setIsSidebarPeekOpen(false);
    window.localStorage.setItem('easymoney:sidebar-collapsed', String(nextValue));
  };

  useEffect(() => {
    let cancelled = false;
    const loadReportAccounts = () => {
      fetch('/api/networth')
        .then(response => {
          if (!response.ok) throw new Error(`Account picker request failed: ${response.status}`);
          return response.json();
        })
        .then(data => {
          if (!cancelled) setReportAccounts(data.accounts || []);
        })
        .catch(() => {
          if (!cancelled) setReportAccounts([]);
        });
    };
    loadReportAccounts();
    const unsubscribe = subscribeToDataChanges(loadReportAccounts);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const reportSelectedIds = useMemo(
    () => selectedReportAccountIds ?? new Set(reportAccounts.map(account => account.id)),
    [reportAccounts, selectedReportAccountIds]
  );

  return (
    <Router>
      <div className={`app-shell ${isSidebarCollapsed ? 'app-shell--sidebar-collapsed' : ''} ${isSidebarPeekOpen ? 'app-shell--sidebar-peek' : ''}`}>
        <Sidebar
          isMobileOpen={isMobileSidebarOpen}
          onClose={() => setIsMobileSidebarOpen(false)}
          isCollapsed={isSidebarCollapsed}
          isPeekOpen={isSidebarPeekOpen}
          onPeekOpen={() => setIsSidebarPeekOpen(true)}
          onPeekClose={() => setIsSidebarPeekOpen(false)}
          onCollapsedChange={handleSidebarCollapsedChange}
          reportAccounts={reportAccounts}
          selectedReportAccountIds={reportSelectedIds}
          onReportAccountSelectionChange={setSelectedReportAccountIds}
        />
        {isSidebarCollapsed && (
          <div
            className="sidebar-peek-zone"
            onPointerEnter={() => setIsSidebarPeekOpen(true)}
            onMouseEnter={() => setIsSidebarPeekOpen(true)}
            aria-hidden="true"
          />
        )}
        <button
          className="mobile-sidebar-trigger"
          type="button"
          aria-label="Open navigation"
          onClick={() => setIsMobileSidebarOpen(true)}
        >
          <Menu size={20} />
        </button>
        <div className="app-content">
          <main className="app-main">
            <Routes>
              <Route path="/" element={<AnalyticsPage />} />
              <Route path="/transactions" element={<TransactionsPage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/budgeting" element={<BudgetingPage />} />
              <Route path="/net-worth" element={<NetWorthPage view="networth" selectedIds={reportSelectedIds} />} />
              <Route path="/performance" element={<NetWorthPage view="performance" selectedIds={reportSelectedIds} />} />
              <Route path="/savings-rate" element={<SavingsRatePage selectedIds={reportSelectedIds} />} />
              <Route path="/retirement" element={<RetirementPage selectedIds={reportSelectedIds} />} />
              <Route path="/investments" element={<Navigate to="/net-worth" replace />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/analytics" element={<Navigate to="/" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </Router>
  );
}

export default App;
