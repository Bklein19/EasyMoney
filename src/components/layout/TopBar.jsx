import { Menu, ChevronDown, Bell } from 'lucide-react';
import Button from '../shared/Button';
import './TopBar.css';

const TopBar = ({ onMenuClick, title = 'EasyMoney' }) => {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button 
          className="topbar-mobile-menu"
          onClick={onMenuClick}
          aria-label="Toggle Menu"
        >
          <Menu size={24} />
        </button>
        <h1 className="topbar-title">{title}</h1>
      </div>

      <div className="topbar-right">
        <Button variant="ghost" iconOnly aria-label="Notifications">
          <Bell size={18} />
        </Button>
        
        <div className="account-selector" role="button" tabIndex={0}>
          <div className="account-avatar">
            VV
          </div>
          <span className="account-name">Local Profile</span>
          <ChevronDown size={14} className="account-chevron" />
        </div>
      </div>
    </header>
  );
};

export default TopBar;
