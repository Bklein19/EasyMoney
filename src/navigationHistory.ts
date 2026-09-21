const STORAGE_KEY = 'easymoney:navigation-history:v1';
const SESSION = '__easyMoneyHistorySession';
const ENTRY = '__easyMoneyHistoryEntry';
const ROUTES = new Set(['/', '/analytics', '/transactions', '/transactions/review', '/accounts', '/categories', '/budgeting', '/backups', '/net-worth', '/performance', '/savings-rate', '/retirement', '/investments', '/import']);

interface HistoryEntry { url: string; key: string }
export interface SavedNavigation { version: 1; session: string; entries: HistoryEntry[]; index: number }

export function validHistoryUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
  try {
    const url = new URL(value, 'https://easymoney.invalid');
    return url.origin === 'https://easymoney.invalid' && ROUTES.has(url.pathname);
  } catch { return false; }
}

export function readNavigation(raw: string | null): SavedNavigation | null {
  try {
    const saved = JSON.parse(raw ?? 'null');
    if (saved?.version !== 1 || typeof saved.session !== 'string' || !saved.session || !Array.isArray(saved.entries) || !saved.entries.length) return null;
    if (!Number.isInteger(saved.index) || saved.index < 0 || saved.index >= saved.entries.length) return null;
    const keys = new Set<string>();
    for (const entry of saved.entries) {
      if (!entry || !validHistoryUrl(entry.url) || typeof entry.key !== 'string' || !entry.key || keys.has(entry.key)) return null;
      keys.add(entry.key);
    }
    return saved;
  } catch { return null; }
}

export function pushNavigation(saved: SavedNavigation, entry: HistoryEntry): SavedNavigation {
  const entries = [...saved.entries.slice(0, saved.index + 1), entry];
  return { ...saved, entries, index: entries.length - 1 };
}

// Install before BrowserRouter mounts, so there is one real browser history stack.
// Only URLs and opaque entry keys are durable, never transient form/ledger data.
export async function restoreNavigation(target: Window): Promise<void> {
  const history = target.history;
  const originalPush = history.pushState.bind(history);
  const originalReplace = history.replaceState.bind(history);
  const currentUrl = () => `${target.location.pathname === '/index.html' ? '/' : target.location.pathname}${target.location.search}${target.location.hash}`;
  const newKey = () => crypto.randomUUID();
  let saved: SavedNavigation | null = null;
  try { saved = readNavigation(target.localStorage.getItem(STORAGE_KEY)); } catch { /* Storage may be disabled. */ }
  const state = history.state;
  const existingIndex = saved && state?.[SESSION] === saved.session ? saved.entries.findIndex(entry => entry.key === state?.[ENTRY]) : -1;
  let snapshot: SavedNavigation;
  if (saved && existingIndex >= 0 && saved.entries[existingIndex].url === currentUrl()) {
    // A browser reload already has the stack. Do not append a second copy.
    snapshot = { ...saved, index: existingIndex };
  } else if (saved && currentUrl() === '/' && history.length <= 1) {
    snapshot = { ...saved, session: newKey() };
    const restoredState = (index: number) => ({ idx: index, key: snapshot.entries[index].key, [SESSION]: snapshot.session, [ENTRY]: snapshot.entries[index].key });
    originalReplace(restoredState(0), '', snapshot.entries[0].url);
    for (let index = 1; index < snapshot.entries.length; index++) originalPush(restoredState(index), '', snapshot.entries[index].url);
    const delta = snapshot.index - snapshot.entries.length + 1;
    if (delta !== 0) {
      await new Promise<void>(resolve => {
        const finish = () => { target.removeEventListener('popstate', finish); target.clearTimeout(timer); resolve(); };
        const timer = target.setTimeout(finish, 1500);
        target.addEventListener('popstate', finish, { once: true });
        history.go(delta);
      });
      const actualIndex = snapshot.entries.findIndex(entry => entry.key === history.state?.[ENTRY]);
      if (actualIndex >= 0) snapshot.index = actualIndex;
    }
  } else {
    snapshot = { version: 1, session: newKey(), entries: [{ url: currentUrl(), key: newKey() }], index: 0 };
  }

  const persist = () => {
    try { target.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* Navigation must work without storage. */ }
  };
  const taggedState = (data: unknown, key: string) => ({
    ...(data && typeof data === 'object' ? data : {}),
    [SESSION]: snapshot.session, [ENTRY]: key,
  });
  originalReplace(taggedState(history.state, snapshot.entries[snapshot.index].key), '', currentUrl());
  persist();

  history.pushState = (data, unused, url) => {
    const key = newKey();
    originalPush(taggedState(data, key), unused, url);
    snapshot = pushNavigation(snapshot, { url: currentUrl(), key });
    persist();
  };
  history.replaceState = (data, unused, url) => {
    const key = snapshot.entries[snapshot.index].key;
    originalReplace(taggedState(data, key), unused, url);
    snapshot.entries[snapshot.index] = { url: currentUrl(), key };
    persist();
  };
  target.addEventListener('popstate', () => {
    const index = snapshot.entries.findIndex(entry => entry.key === history.state?.[ENTRY]);
    if (index >= 0) { snapshot.index = index; persist(); }
  });
}
