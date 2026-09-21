export const SIDEBAR_PATHS = ['/', '/transactions', '/accounts', '/categories', '/budgeting', '/backups', '/net-worth', '/performance', '/savings-rate', '/retirement', '/import'];
export const DEFAULT_PRIMARY_PATHS = ['/', '/transactions', '/net-worth', '/import'];
export const SIDEBAR_PREFERENCES_KEY = 'easymoney:sidebar-navigation';
export interface SidebarPreferences { order: string[]; visible: string[] }

export function readSidebarPreferences(raw: string | null): SidebarPreferences {
  try {
    const value = JSON.parse(raw || 'null');
    if (!Array.isArray(value?.order) || !Array.isArray(value?.visible)) throw new Error('Invalid preferences');
    return {
      order: [...new Set<string>(value.order.filter((path: unknown) => typeof path === 'string' && SIDEBAR_PATHS.includes(path)).concat(SIDEBAR_PATHS))],
      visible: [...new Set<string>(value.visible.filter((path: unknown) => typeof path === 'string' && SIDEBAR_PATHS.includes(path)))],
    };
  } catch { return { order: [...SIDEBAR_PATHS], visible: [...DEFAULT_PRIMARY_PATHS] }; }
}

export function moveSidebarPath(order: string[], source: string, target: string) {
  if (!order.includes(source) || !order.includes(target) || source === target) return order;
  const next = order.filter(path => path !== source);
  next.splice(order.indexOf(target), 0, source);
  return next;
}
