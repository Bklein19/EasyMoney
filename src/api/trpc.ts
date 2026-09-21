import { QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { AppRouter } from '../../server/app/router.ts';
import { desktopBridge } from './desktopBridge';
import { electrobunLink } from './electrobunLink.ts';

export const queryClient = new QueryClient();

function desktopLink() {
  const bridge = desktopBridge;
  if (!bridge) return null;
  return electrobunLink<AppRouter>((request) => bridge.rpc!.request.trpc(request));
}

export const trpcClient = createTRPCClient<AppRouter>({
  links: [desktopLink() ?? httpBatchLink({ url: '/api/trpc' })],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({
  client: trpcClient,
  queryClient,
});
