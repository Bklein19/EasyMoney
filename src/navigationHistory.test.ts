import { expect, test } from 'bun:test';
import { pushNavigation, readNavigation, restoreNavigation, validHistoryUrl, type SavedNavigation } from './navigationHistory';

const saved: SavedNavigation = { version: 1, session: 'session', entries: [
  { url: '/', key: 'a' }, { url: '/accounts?edit=5', key: 'b' }, { url: '/backups#history', key: 'c' },
], index: 1 };

test('restores current position with both back and forward entries and URL details', () => {
  expect(readNavigation(JSON.stringify(saved))).toEqual(saved);
});
test('new navigation after going back truncates only the forward branch', () => {
  const next = pushNavigation(saved, { url: '/import', key: 'd' });
  expect(next.entries.map(entry => entry.url)).toEqual(['/', '/accounts?edit=5', '/import']);
  expect(next.index).toBe(2);
  expect(saved.entries[2].url).toBe('/backups#history');
});
test('invalid snapshots and foreign or unsupported URLs are rejected', () => {
  for (const url of ['https://evil.test', '//evil.test', '/\\evil.test', '/unknown']) expect(validHistoryUrl(url)).toBe(false);
  for (const raw of ['bad', 'null', '{}', JSON.stringify({ ...saved, index: 9 }),
    JSON.stringify({ ...saved, entries: [{ url: '//evil.test', key: 'a' }] }),
    JSON.stringify({ ...saved, entries: [saved.entries[0], saved.entries[0]] })]) expect(readNavigation(raw)).toBeNull();
});

function browser(storage = new Map<string, string>(), initialUrl = '/') {
  const events = new EventTarget();
  const entries: { url: string; state: unknown }[] = [{ url: initialUrl, state: null }];
  let index = 0;
  const history = {
    get length() { return entries.length; },
    get state() { return entries[index].state; },
    pushState(state: unknown, _unused: string, url?: string | URL | null) {
      entries.splice(index + 1);
      entries.push({ state, url: url ? String(url) : entries[index].url });
      index++;
    },
    replaceState(state: unknown, _unused: string, url?: string | URL | null) {
      entries[index] = { state, url: url ? String(url) : entries[index].url };
    },
    go(delta: number) {
      const next = index + delta;
      if (next < 0 || next >= entries.length) return;
      index = next;
      queueMicrotask(() => events.dispatchEvent(new Event('popstate')));
    },
  };
  const target = Object.assign(events, {
    history,
    get location() { return new URL(entries[index].url, 'https://easymoney.invalid'); },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
    setTimeout, clearTimeout,
  });
  // Object.assign evaluates getters; location must remain live as history moves.
  Object.defineProperty(target, 'location', { get: () => new URL(entries[index].url, 'https://easymoney.invalid') });
  return { target: target as unknown as Window, history, storage, entries, url: () => entries[index].url };
}

test('launch reconstructs the real stack, restores its cursor and supports forward navigation', async () => {
  const first = browser();
  await restoreNavigation(first.target);
  first.history.pushState({ idx: 1 }, '', '/accounts');
  first.history.pushState({ idx: 2 }, '', '/import');
  first.history.go(-1);
  await Promise.resolve();
  const relaunched = browser(first.storage);
  await restoreNavigation(relaunched.target);
  expect(relaunched.url()).toBe('/accounts');
  expect(relaunched.entries.map(entry => entry.url)).toEqual(['/', '/accounts', '/import']);
  relaunched.history.go(1);
  await Promise.resolve();
  expect(relaunched.url()).toBe('/import');
  relaunched.history.go(-2);
  await Promise.resolve();
  expect(relaunched.url()).toBe('/');
});

test('reload does not duplicate entries and explicit deep links win over saved history', async () => {
  const first = browser();
  await restoreNavigation(first.target);
  first.history.pushState({ idx: 1 }, '', '/accounts');
  await restoreNavigation(first.target);
  expect(first.entries).toHaveLength(2);
  const deepLink = browser(first.storage, '/backups#history');
  await restoreNavigation(deepLink.target);
  expect(deepLink.url()).toBe('/backups#history');
  expect(deepLink.entries).toHaveLength(1);
});
