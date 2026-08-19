import { QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { Electroview } from 'electrobun/view';
import type { AppRouter } from '../../server/app/router.ts';
import type { EasyMoneyDesktopRpc } from '../../desktop/rpc.ts';
import { electrobunLink } from './electrobunLink.ts';

export const queryClient = new QueryClient();

function desktopLink() {
  if (typeof window.__electrobunWebviewId !== 'number') return null;
  const rpc = Electroview.defineRPC<EasyMoneyDesktopRpc>({
    maxRequestTime: Infinity,
    handlers: { requests: {}, messages: {} },
  });
  const electrobun = new Electroview({ rpc });
  return electrobunLink<AppRouter>((request) => electrobun.rpc!.request.trpc(request));
}

export const trpcClient = createTRPCClient<AppRouter>({
  links: [desktopLink() ?? httpBatchLink({ url: '/api/trpc' })],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({
  client: trpcClient,
  queryClient,
});
