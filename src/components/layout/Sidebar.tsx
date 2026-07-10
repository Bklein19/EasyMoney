import { useEffect, useMemo, useRef, type ComponentType } from 'react';
import { NavLink, useLocation } from 'react-router';
import { 
  ArrowLeftRight, 
  WalletCards, 
  Upload, 
  PieChart,
  Activity,
  LineChart,
  Wallet,
  PiggyBank,
  Landmark,
  Link2,
  Tags
} from 'lucide-react';
import type { LucideProps } from 'lucide-react';
import { useCategories } from '../../hooks/useCategories';
import { CATEGORY_GROUPS, categoryGroupKey } from '../../utils/categoryGroups';
import { AccountPicker } from '../investments/AccountPicker';
import './Sidebar.css';

const REPORT_ROUTES = new Set(['/net-worth', '/performance', '/savings-rate', '/retirement']);
const SIDEBAR_WIDTH_KEY = 'easymoney:sidebar-width';
const SIDEBAR_MIN_WIDTH = 168;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_COLLAPSE_THRESHOLD = 112;

interface SidebarAccount {
  id: number;
  name: string;
  institution: string;
  type: string;
  account_holder?: string | null;
}

interface SidebarProps {
  isMobileOpen: boolean;
  onClose: () => void;
  isCollapsed?: boolean;
  isPeekOpen?: boolean;
  onCollapsedChange?: (nextValue: boolean) => void;
  reportAccounts?: SidebarAccount[];
  selectedReportAccountIds?: Set<number>;
  onReportAccountSelectionChange?: (next: Set<number>) => void;
}

interface NavItem {
  path: string;
  label: string;
  icon: ComponentType<LucideProps>;
}

const Sidebar = ({
  isMobileOpen,
  onClose,
  isCollapsed = false,
  isPeekOpen = false,
  onCollapsedChange,
  reportAccounts = [],
  selectedReportAccountIds = new Set(),
  onReportAccountSelectionChange,
}: SidebarProps) => {
  const location = useLocation();
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const { categories } = useCategories();
  const categoryGroupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const category of categories) {
      const key = categoryGroupKey(category.categoryGroup);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [categories]);
  const navItems: NavItem[] = [
    { path: '/', label: 'Analytics', icon: PieChart },
    { path: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
    { path: '/accounts', label: 'Accounts', icon: WalletCards },
    { path: '/categories', label: 'Categories', icon: Tags },
    { path: '/budgeting', label: 'Budgeting', icon: PiggyBank },
    { path: '/net-worth', label: 'Net Worth', icon: Wallet },
    { path: '/performance', label: 'Performance', icon: LineChart },
    { path: '/savings-rate', label: 'Savings Rate', icon: Activity },
    { path: '/retirement', label: 'Retirement', icon: Landmark },
    { path: '/connections', label: 'Connections', icon: Link2 },
    { path: '/import', label: 'Import', icon: Upload },
  ];
  const showAccountPicker = (
    (!isCollapsed || isPeekOpen) &&
    REPORT_ROUTES.has(location.pathname) &&
    reportAccounts.length > 0 &&
    onReportAccountSelectionChange
  );
  const showCategoryGroups = !isCollapsed || isPeekOpen;
  const activeCategoryGroup = new URLSearchParams(location.search).get('group') || '';

  useEffect(() => {
    const savedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (!Number.isFinite(savedWidth) || savedWidth <= 0) return;
    const width = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, savedWidth));
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
    sidebarRef.current?.style.setProperty('--sidebar-width', `${width}px`);
  }, []);

  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!sidebarRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('sidebar-resizing');
    const left = sidebarRef.current.getBoundingClientRect().left;
    let frameId = 0;
    let pendingClientX = event.clientX;
    let nextCollapsed = isCollapsed;

    const setWidth = (clientX: number, { commit = false }: { commit?: boolean } = {}) => {
      if (!sidebarRef.current) return null;
      const rawWidth = clientX - left;
      if (rawWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
        if (!nextCollapsed) {
          nextCollapsed = true;
          onCollapsedChange?.(true);
        }
        return null;
      }

      const wasCollapsed = nextCollapsed;
      if (nextCollapsed) {
        nextCollapsed = false;
        onCollapsedChange?.(false);
      }
      const width = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, rawWidth));
      sidebarRef.current.style.setProperty('--sidebar-width', `${width}px`);
      if (commit || wasCollapsed) {
        document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
      }
      return width;
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      pendingClientX = moveEvent.clientX;
      if (frameId) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        setWidth(pendingClientX);
      });
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
      }
      const width = setWidth(upEvent.clientX, { commit: true });
      if (width) window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.requestAnimationFrame(() => {
        document.body.classList.remove('sidebar-resizing');
      });
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
          className="sidebar-mobile-overlay"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      
      <div
        ref={sidebarRef}
        className={`sidebar ${isMobileOpen ? 'mobile-open' : ''} ${isCollapsed ? 'sidebar--collapsed' : ''} ${isPeekOpen ? 'sidebar--peek' : ''}`}
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
            <div className="sidebar-nav-item" key={item.path}>
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  `sidebar-link ${isActive ? 'active' : ''}`
                }
                onClick={onClose}
                aria-label={item.label}
                title={isCollapsed && !isPeekOpen ? item.label : undefined}
              >
                <item.icon size={20} className="sidebar-link-icon" />
                <span className="sidebar-link-label">{item.label}</span>
              </NavLink>

              {item.path === '/categories' && showCategoryGroups && location.pathname === '/categories' && (
                <div className="sidebar-category-groups" aria-label="Category groups">
                  {CATEGORY_GROUPS.map(group => {
                    const count = categoryGroupCounts.get(group.key) ?? 0;
                    if (count === 0) return null;
                    const isActive = activeCategoryGroup === group.key;
                    return (
                      <NavLink
                        key={group.key}
                        to={`/categories?group=${group.key}`}
                        className={`sidebar-category-group ${isActive ? 'active' : ''}`}
                        onClick={onClose}
                      >
                        <span>{group.label}</span>
                        <span>{count}</span>
                      </NavLink>
                    );
                  })}
                </div>
              )}
            </div>
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
