import { Electroview } from 'electrobun/view';
import type { EasyMoneyDesktopRpc } from '../../desktop/rpc';

function createDesktopBridge() {
  if (typeof window === 'undefined' || typeof window.__electrobunWebviewId !== 'number') return null;
  const rpc = Electroview.defineRPC<EasyMoneyDesktopRpc>({
    maxRequestTime: Infinity,
    handlers: {
      requests: {},
      messages: {
        editAccount: ({ accountId }) => {
          window.dispatchEvent(new CustomEvent('easymoney:edit-account', { detail: accountId }));
        },
      },
    },
  });
  return new Electroview({ rpc });
}

export const desktopBridge = createDesktopBridge();
