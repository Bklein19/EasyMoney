import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { trpc } from '../../api/trpc';
import { importAttentionMessage } from '../shared/importAttention';
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
  Tags
} from 'lucide-react';
import { Ellipsis, GripVertical, ArrowUp, ArrowDown, Settings2 } from 'lucide-react';
import { readSidebarPreferences, moveSidebarPath, insertSidebarPath, SIDEBAR_PREFERENCES_KEY } from './sidebarPreferences';
import { SidebarContextSlot } from './SidebarContext';
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
  const coverage = useQuery({ ...trpc.dataFreshness.report.queryOptions(), staleTime: 60_000 });
  const importAttention = importAttentionMessage(coverage.data?.accounts, coverage.isError);
  const categorization = useQuery({ ...trpc.transactions.categorizationCoverage.queryOptions(), staleTime: 30_000, refetchInterval: 30_000 });
  const uncategorizedCount = categorization.isError ? 0 : categorization.data?.uncategorizedCount ?? 0;
  const categorizationLabel = uncategorizedCount > 0 ? `${uncategorizedCount.toLocaleString()} transactions need categorizing` : undefined;
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const overflowRef = useRef<HTMLDetailsElement | null>(null);
  const [preferences, setPreferences] = useState(() => {
    try { return readSidebarPreferences(localStorage.getItem(SIDEBAR_PREFERENCES_KEY)); }
    catch { return readSidebarPreferences(null); }
  });
  const [isCustomizing, setIsCustomizing] = useState(false);
  const draggedPath = useRef<string | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ path: string; edge: 'before' | 'after' } | null>(null);
  const clearDrag = () => { draggedPath.current = null; setDraggingPath(null); setDropTarget(null); };
  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Navigation still works without persistence. */ }
  }, [preferences]);
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
    { path: '/backups', label: 'Backups', icon: WalletCards },
    { path: '/net-worth', label: 'Net Worth', icon: Wallet },
    { path: '/performance', label: 'Performance', icon: LineChart },
    { path: '/savings-rate', label: 'Savings Rate', icon: Activity },
    { path: '/retirement', label: 'Retirement', icon: Landmark },
    { path: '/import', label: 'Import', icon: Upload },
  ];
  const showAccountPicker = (
    (!isCollapsed || isPeekOpen || isMobileOpen) &&
    REPORT_ROUTES.has(location.pathname) &&
    reportAccounts.length > 0 &&
    onReportAccountSelectionChange
  );
  const showCategoryGroups = !isCollapsed || isPeekOpen || isMobileOpen;
  const activeCategoryGroup = new URLSearchParams(location.search).get('group') || '';
  const orderedItems = preferences.order.flatMap(path => navItems.filter(item => item.path === path));
  const primaryItems = orderedItems.filter(item => preferences.visible.includes(item.path));
  const overflowItems = orderedItems.filter(item => !preferences.visible.includes(item.path));
  const activeOverflow = overflowItems.find(item => item.path === location.pathname);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !overflowRef.current?.contains(event.target) && overflowRef.current) overflowRef.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && overflowRef.current?.open) {
        overflowRef.current.open = false;
        overflowRef.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, []);

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
        <div className="sidebar-header electrobun-webkit-app-region-drag">
          <NavLink
            to="/"
            className="sidebar-brand electrobun-webkit-app-region-no-drag"
            onClick={onClose}
          >
            <div className="sidebar-brand-icon">
              <Wallet size={18} />
            </div>
            <span className="sidebar-brand-text">EasyMoney</span>
          </NavLink>
        </div>

        <nav className="sidebar-nav" aria-label="Main navigation">
          {primaryItems.map((item) => (
            <div className="sidebar-nav-item" key={item.path}>
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  `sidebar-link ${isActive ? 'active' : ''}`
                }
                onClick={onClose}
                aria-label={item.path === '/transactions' && categorizationLabel ? `Transactions: ${categorizationLabel}` : item.path === '/import' && importAttention ? `Import: ${importAttention}` : item.label}
                title={item.path === '/transactions' && categorizationLabel ? categorizationLabel : item.path === '/import' && importAttention ? importAttention : isCollapsed && !isPeekOpen ? item.label : undefined}
              >
                <item.icon size={20} className="sidebar-link-icon" />
                <span className="sidebar-link-label">{item.label}</span>
                {item.path === '/transactions' && uncategorizedCount > 0 && <span className="sidebar-count-badge" aria-hidden="true">{uncategorizedCount.toLocaleString()}</span>}
                {item.path === '/import' && importAttention && <span className="sidebar-import-indicator" aria-hidden="true" />}
              </NavLink>

            </div>
          ))}
          <details className="sidebar-overflow" ref={overflowRef}>
            <summary className={`sidebar-link ${activeOverflow ? 'active' : ''}`} title="More pages">
              <Ellipsis size={20} /><span className="sidebar-link-label">{activeOverflow?.label ?? 'More'}</span>
              {!preferences.visible.includes('/import') && importAttention && <span className="sidebar-import-indicator" title={importAttention} />}
            </summary>
            <div className="sidebar-overflow-panel" aria-label="More pages">
              {isCustomizing ? <>
                <div className="sidebar-customize-header"><strong>Customize navigation</strong><button className="btn btn--ghost btn--sm" onClick={() => setIsCustomizing(false)}>Done</button></div>
                {orderedItems.map((item, index) => <div className={`sidebar-customize-row ${draggingPath === item.path ? 'is-dragging' : ''} ${dropTarget?.path === item.path ? `drop-${dropTarget.edge}` : ''}`} key={item.path}
                  onDragOver={event => {
                    if (!draggedPath.current) return;
                    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
                    const rect = event.currentTarget.getBoundingClientRect();
                    const edge = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                    setDropTarget(current => current?.path === item.path && current.edge === edge ? current : { path: item.path, edge });
                  }}
                  onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null); }}
                  onDrop={event => {
                    event.preventDefault(); const source = draggedPath.current;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const edge = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                    if (source) setPreferences(current => ({ ...current, order: insertSidebarPath(current.order, source, item.path, edge) }));
                    clearDrag();
                  }}>
                  <label><input type="checkbox" checked={preferences.visible.includes(item.path)} onChange={event => { const checked = event.target.checked; setPreferences(current => ({ ...current, visible: checked ? [...current.visible, item.path] : current.visible.filter(path => path !== item.path) })); }} /><item.icon size={17} /><span>{item.label}</span></label>
                  <button className="icon-btn" aria-label={`Move ${item.label} up`} disabled={index === 0} onClick={() => setPreferences(current => ({ ...current, order: moveSidebarPath(current.order, item.path, current.order[index - 1]) }))}><ArrowUp size={13} /></button>
                  <button className="icon-btn" aria-label={`Move ${item.label} down`} disabled={index === orderedItems.length - 1} onClick={() => setPreferences(current => ({ ...current, order: moveSidebarPath(current.order, item.path, current.order[index + 1]) }))}><ArrowDown size={13} /></button>
                  <span className="sidebar-drag-handle" draggable title={`Drag to reorder ${item.label}`} onDragStart={event => {
                    draggedPath.current = item.path; event.dataTransfer.setData('text/plain', item.path); event.dataTransfer.effectAllowed = 'move';
                    const row = event.currentTarget.parentElement;
                    if (row) event.dataTransfer.setDragImage(row, row.clientWidth - 16, row.clientHeight / 2);
                    setDraggingPath(item.path);
                  }} onDragEnd={clearDrag}><GripVertical size={15} aria-hidden="true" /></span>
                </div>)}
                <button className="btn btn--ghost btn--sm" onClick={() => setPreferences(readSidebarPreferences(null))}>Reset to defaults</button>
              </> : <>
              {overflowItems.map(item => <NavLink key={item.path} to={item.path} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`} onClick={() => { if (overflowRef.current) overflowRef.current.open = false; onClose(); }}>
                <item.icon size={18} /><span>{item.label}</span>
                {item.path === '/transactions' && uncategorizedCount > 0 && <span className="sidebar-count-badge" title={categorizationLabel}>{uncategorizedCount.toLocaleString()}</span>}
                {item.path === '/import' && importAttention && <span className="sidebar-import-indicator" title={importAttention} />}
              </NavLink>)}
              <button className="sidebar-link sidebar-customize-button" onClick={() => setIsCustomizing(true)}><Settings2 size={18} />Customize…</button>
              </>}
            </div>
          </details>
        </nav>
        <div className="sidebar-context" aria-label="Page controls" key={location.pathname}>
              {showCategoryGroups && location.pathname === '/categories' && (
                <section>
                  <h2 className="sidebar-context-title">Category groups</h2>
                  <NavLink to="/categories" className={`sidebar-category-group ${!activeCategoryGroup ? 'active' : ''}`} onClick={onClose}>All categories</NavLink>
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
                </section>
              )}

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
                variant="owner-groups"
              />
            </section>
          )}
          <SidebarContextSlot />
        </div>

        <div className="sidebar-resize-handle" onPointerDown={startSidebarResize} />
      </div>
    </>
  );
};

export default Sidebar;
