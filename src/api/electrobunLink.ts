import { TRPCClientError, type TRPCLink } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import type { DesktopTrpcRequest, DesktopTrpcResponse } from '../../desktop/rpc.ts';

export type DesktopTrpcRequester = (request: DesktopTrpcRequest) => Promise<DesktopTrpcResponse>;

export function electrobunLink<TRouter extends AnyRouter>(request: DesktopTrpcRequester): TRPCLink<TRouter> {
  return () => ({ op }) => observable((observer) => {
    if (op.type === 'subscription') {
      observer.error(TRPCClientError.from(new Error('Subscriptions are not supported by the Electrobun transport.')));
      return;
    }

    let active = true;
    request({ path: op.path, type: op.type, input: op.input })
      .then((response) => {
        if (!active) return;
        if (!response.ok) {
          observer.error(TRPCClientError.from({ error: response.error }));
          return;
        }
        observer.next({ result: { data: response.data } });
        observer.complete();
      })
      .catch((cause) => {
        if (active) observer.error(TRPCClientError.from(cause));
      });

    return () => {
      active = false;
    };
  });
}
