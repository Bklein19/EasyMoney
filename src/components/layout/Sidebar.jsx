import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router';
import { 
  ArrowLeftRight, 
  WalletCards, 
  Upload, 
  PieChart,
  Activity,
  LineChart,
  Wallet,
  PiggyBank
} from 'lucide-react';
import { AccountPicker } from '../investments/AccountPicker';
import './Sidebar.css';

const REPORT_ROUTES = new Set(['/net-worth', '/performance', '/savings-rate']);
const SIDEBAR_WIDTH_KEY = 'easymoney:sidebar-width';
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_COLLAPSE_THRESHOLD = 150;

const Sidebar = ({
  isMobileOpen,
  onClose,
  isCollapsed = false,
  onCollapsedChange,
  reportAccounts = [],
  selectedReportAccountIds = new Set(),
  onReportAccountSelectionChange,
}) => {
  const location = useLocation();
  const sidebarRef = useRef(null);
  const navItems = [
    { path: '/', label: 'Analytics', icon: PieChart },
    { path: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
    { path: '/accounts', label: 'Accounts', icon: WalletCards },
    { path: '/budgeting', label: 'Budgeting', icon: PiggyBank },
    { path: '/net-worth', label: 'Net Worth', icon: Wallet },
    { path: '/performance', label: 'Performance', icon: LineChart },
    { path: '/savings-rate', label: 'Savings Rate', icon: Activity },
    { path: '/import', label: 'Import', icon: Upload },
  ];
  const showAccountPicker = (
    !isCollapsed &&
    REPORT_ROUTES.has(location.pathname) &&
    reportAccounts.length > 0 &&
    onReportAccountSelectionChange
  );

  useEffect(() => {
    const savedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (!Number.isFinite(savedWidth) || savedWidth <= 0) return;
    const width = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, savedWidth));
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
    sidebarRef.current?.style.setProperty('--sidebar-width', `${width}px`);
  }, []);

  const startSidebarResize = (event) => {
    if (!sidebarRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('sidebar-resizing');
    const left = sidebarRef.current.getBoundingClientRect().left;

    const setWidth = (clientX) => {
      if (!sidebarRef.current) return null;
      const rawWidth = clientX - left;
      if (rawWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
        onCollapsedChange?.(true);
        return null;
      }

      onCollapsedChange?.(false);
      const width = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, rawWidth));
      document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
      sidebarRef.current.style.setProperty('--sidebar-width', `${width}px`);
      return width;
    };

    const handlePointerMove = (moveEvent) => {
      setWidth(moveEvent.clientX);
    };
    const handlePointerUp = (upEvent) => {
      const width = setWidth(upEvent.clientX);
      if (width) window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
      document.body.classList.remove('sidebar-resizing');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  };

  return (
    <>
      {/* Mobile overlay */}
      {isMobileOpen && (
        <div 
          className="fixed inset-0 bg-black/60 z-40 md:hidden" 
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      
      <div
        ref={sidebarRef}
        className={`sidebar ${isMobileOpen ? 'mobile-open' : ''} ${isCollapsed ? 'sidebar--collapsed' : ''}`}
      >
        <div className="sidebar-header">
          <NavLink to="/" className="sidebar-brand" onClick={onClose}>
            <div className="sidebar-brand-icon">
              <Wallet size={18} />
            </div>
            <span className="sidebar-brand-text">EasyMoney</span>
          </NavLink>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => 
                `sidebar-link ${isActive ? 'active' : ''}`
              }
              onClick={onClose}
              aria-label={item.label}
              title={isCollapsed ? item.label : undefined}
            >
              <item.icon size={20} className="sidebar-link-icon" />
              <span className="sidebar-link-label">{item.label}</span>
            </NavLink>
          ))}

          {showAccountPicker && (
            <section className="sidebar-account-picker" aria-label="Report accounts">
              <div className="sidebar-account-picker__header">
                <span>Accounts</span>
                <span>{selectedReportAccountIds.size} of {reportAccounts.length}</span>
              </div>
              <AccountPicker
                accounts={reportAccounts}
                selectedIds={selectedReportAccountIds}
                onChange={onReportAccountSelectionChange}
              />
            </section>
          )}
        </nav>

        <div className="sidebar-resize-handle" onPointerDown={startSidebarResize} />
      </div>
    </>
  );
};

export default Sidebar;
