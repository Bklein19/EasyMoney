import { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router';
import ImportPage from './components/import/ImportPage';
import DashboardPage from './components/dashboard/DashboardPage';
import TransactionsPage from './components/transactions/TransactionsPage';
import AccountsPage from './components/accounts/AccountsPage';
import Sidebar from './components/layout/Sidebar';
import AnalyticsPage from './components/analytics/AnalyticsPage';
import BudgetingPage from './components/budgeting/BudgetingPage';
import InvestmentsPage from './components/investments/InvestmentsPage';
import HowToUsePage from './components/help/HowToUsePage';
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

  const handleSidebarCollapsedChange = (nextValue) => {
    setIsSidebarCollapsed(nextValue);
    window.localStorage.setItem('easymoney:sidebar-collapsed', String(nextValue));
  };

  return (
    <Router>
      <div className={`app-shell ${isSidebarCollapsed ? 'app-shell--sidebar-collapsed' : ''}`}>
        <Sidebar
          isCollapsed={isSidebarCollapsed}
          onCollapsedChange={handleSidebarCollapsedChange}
        />
        <div className="app-content">
          <main className="app-main">
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/transactions" element={<TransactionsPage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/budgeting" element={<BudgetingPage />} />
              <Route path="/investments" element={<InvestmentsPage />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/how-to-use" element={<HowToUsePage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </Router>
  );
}

export default App;
