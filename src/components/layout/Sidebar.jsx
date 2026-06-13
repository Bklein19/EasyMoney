import { NavLink } from 'react-router';
import { 
  LayoutDashboard, 
  ArrowLeftRight, 
  WalletCards, 
  Upload, 
  PieChart,
  TrendingUp,
  Wallet,
  PiggyBank,
  CircleHelp,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import './Sidebar.css';

const Sidebar = ({ isMobileOpen, onClose, isCollapsed = false, onCollapsedChange }) => {
  const navItems = [
    { path: '/', label: 'Dashboard', icon: LayoutDashboard },
    { path: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
    { path: '/accounts', label: 'Accounts', icon: WalletCards },
    { path: '/budgeting', label: 'Budgeting', icon: PiggyBank },
    { path: '/analytics', label: 'Analytics', icon: PieChart },
    { path: '/investments', label: 'Investments', icon: TrendingUp },
    { path: '/import', label: 'Import', icon: Upload },
    { path: '/how-to-use', label: 'How To Use', icon: CircleHelp },
  ];

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
      
      <div className={`sidebar ${isMobileOpen ? 'mobile-open' : ''} ${isCollapsed ? 'sidebar--collapsed' : ''}`}>
        <div className="sidebar-header">
          <NavLink to="/" className="sidebar-brand" onClick={onClose}>
            <div className="sidebar-brand-icon">
              <Wallet size={18} />
            </div>
            <span className="sidebar-brand-text">EasyMoney</span>
          </NavLink>
          <button
            className="sidebar-toggle"
            type="button"
            onClick={() => onCollapsedChange?.(!isCollapsed)}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
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
        </nav>

        <div className="sidebar-footer">
          {/* Optional: Add user settings or logout link here in the future */}
        </div>
      </div>
    </>
  );
};

export default Sidebar;
