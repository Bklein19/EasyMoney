import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router';
import ImportPage from './components/import/ImportPage';
import DashboardPage from './components/dashboard/DashboardPage';
import TransactionsPage from './components/transactions/TransactionsPage';
import AccountsPage from './components/accounts/AccountsPage';
import Sidebar from './components/layout/Sidebar';
import AnalyticsPage from './components/analytics/AnalyticsPage';
import HowToUsePage from './components/help/HowToUsePage';

function App() {
  return (
    <Router>
      <div style={{ display: 'flex', minHeight: '100vh' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', marginLeft: '250px' }}>
          <main style={{ flex: 1, overflowY: 'auto' }}>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/transactions" element={<TransactionsPage />} />
              <Route path="/accounts" element={<AccountsPage />} />
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
