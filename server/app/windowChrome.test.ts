import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { windowChrome } from '../../desktop/windowChrome';

describe('platform window chrome', () => {
  test.each([
    ['darwin', 'hiddenInset', 'easymoney-macos'],
    ['win32', 'default', 'easymoney-windows'],
    ['linux', 'default', 'easymoney-linux'],
  ] as const)('%s uses the matching native frame and document class', (platform, style, className) => {
    const chrome = windowChrome(platform);
    expect(chrome.titleBarStyle).toBe(style);
    const classes = new Set<string>();
    const root = { classList: { add: (value: string) => classes.add(value) } };
    new Function('document', chrome.preload)({ documentElement: root });
    expect([...classes]).toEqual([className]);
  });

  test('document-start preload tolerates the HTML root not existing yet', () => {
    const classes = new Set<string>();
    let ready: (() => void) | undefined;
    const document = {
      documentElement: null as null | { classList: { add(value: string): void } },
      addEventListener: (event: string, callback: () => void, options: { once: boolean }) => {
        expect(event).toBe('DOMContentLoaded');
        expect(options.once).toBeTrue();
        ready = callback;
      },
    };
    new Function('document', windowChrome('darwin').preload)(document);
    document.documentElement = { classList: { add: value => { classes.add(value); } } };
    ready?.();
    expect([...classes]).toEqual(['easymoney-macos']);
  });

  test('overlay drag strip and traffic-light inset are macOS-only', () => {
    const appCss = readFileSync(new URL('../../src/App.css', import.meta.url), 'utf8');
    const sidebarCss = readFileSync(new URL('../../src/components/layout/Sidebar.css', import.meta.url), 'utf8');
    expect(appCss).toContain('.easymoney-macos .desktop-window-drag-strip');
    expect(appCss).not.toContain('.easymoney-desktop .desktop-window-drag-strip');
    expect(sidebarCss).toContain('.easymoney-macos .sidebar-compact-title');
    expect(sidebarCss).not.toContain('.easymoney-desktop .sidebar-compact-title');
  });
});
