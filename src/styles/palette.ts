import { useSyncExternalStore } from 'react';

export const PALETTES = ['default', 'banknote'] as const;
export type Palette = typeof PALETTES[number];
export const PALETTE_KEY = 'easymoney:palette';
export function readPalette(value: string | null): Palette { return value === 'banknote' ? value : 'default'; }

export function initializePalette(target: Window) {
  let palette: Palette = 'default';
  try { palette = readPalette(target.localStorage.getItem(PALETTE_KEY)); } catch { /* Storage is optional. */ }
  target.document.documentElement.dataset.palette = palette;
}

export function setPalette(palette: Palette) {
  document.documentElement.dataset.palette = palette;
  try { localStorage.setItem(PALETTE_KEY, palette); } catch { /* The current session still works. */ }
  window.dispatchEvent(new Event('easymoney:palette'));
}

function subscribe(change: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== PALETTE_KEY && event.key !== null) return;
    initializePalette(window);
    change();
  };
  window.addEventListener('easymoney:palette', change);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener('easymoney:palette', change); window.removeEventListener('storage', storage); };
}
export function usePalette() {
  return useSyncExternalStore(subscribe, () => readPalette(document.documentElement.dataset.palette ?? null), () => 'default' as Palette);
}
