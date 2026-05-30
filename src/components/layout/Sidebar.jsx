import { NavLink } from 'react-router';
import { 
  LayoutDashboard, 
  ArrowLeftRight, 
  WalletCards, 
  Upload, 
  PieChart,
  Wallet
} from 'lucide-react';
import './Sidebar.css';

const Sidebar = ({ isMobileOpen, onClose }) => {
  const navItems = [
    { path: '/', label: 'Dashboard', icon: LayoutDashboard },
    { path: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
    { path: '/accounts', label: 'Accounts', icon: WalletCards },
    { path: '/analytics', label: 'Analytics', icon: PieChart },
    { path: '/import', label: 'Import', icon: Upload },
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
      
      <div className={`sidebar ${isMobileOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-header">
          <NavLink to="/" className="sidebar-brand" onClick={onClose}>
            <div className="sidebar-brand-icon">
              <Wallet size={18} />
            </div>
            <span>EasyMoney</span>
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
            >
              <item.icon size={20} className="sidebar-link-icon" />
              <span>{item.label}</span>
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
