import { Electroview } from 'electrobun/view';
import type { EasyMoneyDesktopRpc } from '../../desktop/rpc';

function createDesktopBridge() {
  if (typeof window === 'undefined' || typeof window.__electrobunWebviewId !== 'number') return null;
  const rpc = Electroview.defineRPC<EasyMoneyDesktopRpc>({
    maxRequestTime: Infinity,
    handlers: {
      requests: {},
      messages: {
        customizeSidebar: () => window.dispatchEvent(new Event('easymoney:customize-sidebar')),
        navigateHistory: ({ delta }) => {
          window.dispatchEvent(new CustomEvent('easymoney:navigate-history', { detail: delta }));
        },
        editAccount: ({ accountId }) => {
          window.dispatchEvent(new CustomEvent('easymoney:edit-account', { detail: accountId }));
        },
      },
    },
  });
  return new Electroview({ rpc });
}

export const desktopBridge = createDesktopBridge();
