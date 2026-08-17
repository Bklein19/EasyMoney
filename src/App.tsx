import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router';
import { Menu } from 'lucide-react';
import ImportPage from './components/import/ImportPage.jsx';
import TransactionsPage from './components/transactions/TransactionsPage.jsx';
import TransactionReviewPage from './components/transactions/TransactionReviewPage.jsx';
import AccountsPage from './components/accounts/AccountsPage.jsx';
import CategoriesPage from './components/categories/CategoriesPage';
import Sidebar from './components/layout/Sidebar';
import AnalyticsPage from './components/analytics/AnalyticsPage.jsx';
import BudgetingPage from './components/budgeting/BudgetingPage.jsx';
import { NetWorthPage } from './components/investments/NetWorthPage';
import { RetirementPage } from './components/investments/RetirementPage';
import { SavingsRatePage } from './components/investments/SavingsRatePage';
import { trpc } from './api/trpc';
import './App.css';

interface ReportAccount {
  id: number;
  name: string;
  institution: string;
  type: string;
  account_holder?: string | null;
}

interface AppRoutesProps {
  reportSelectedIds: Set<number>;
}

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
  const [selectedReportAccountIds, setSelectedReportAccountIds] = useState<Set<number> | null>(null);
  const reportAccountsQuery = useQuery(trpc.reports.netWorth.queryOptions());
  const reportAccounts: ReportAccount[] = reportAccountsQuery.data?.accounts || [];

  const handleSidebarCollapsedChange = (nextValue: boolean) => {
    setIsSidebarCollapsed(nextValue);
    setIsSidebarPeekOpen(false);
    window.localStorage.setItem('easymoney:sidebar-collapsed', String(nextValue));
  };

  useEffect(() => {
    if (!isSidebarCollapsed || !isSidebarPeekOpen) return undefined;

    const handlePointerMove = (event: PointerEvent) => {
      if (document.body.classList.contains('sidebar-resizing')) return;
      const sidebar = document.querySelector('.sidebar');
      if (!sidebar) return;
      const rect = sidebar.getBoundingClientRect();
      if (event.clientX > rect.right + 16) {
        setIsSidebarPeekOpen(false);
      }
    };

    const handleWindowBlur = () => setIsSidebarPeekOpen(false);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [isSidebarCollapsed, isSidebarPeekOpen]);


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
            <AppRoutes reportSelectedIds={reportSelectedIds} />
          </main>
        </div>
      </div>
    </Router>
  );
}

function AppRoutes({ reportSelectedIds }: AppRoutesProps) {
  return (
    <Routes>
      <Route path="/" element={<AnalyticsPage />} />
      <Route path="/transactions" element={<TransactionsPage />} />
      <Route path="/transactions/review" element={<TransactionReviewPage />} />
      <Route path="/accounts" element={<AccountsPage />} />
      <Route path="/categories" element={<CategoriesPage />} />
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
  );
}

export default App;
