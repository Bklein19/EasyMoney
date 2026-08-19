import { describe, expect, test } from 'bun:test';
import { createTRPCClient, TRPCClientError } from '@trpc/client';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { electrobunLink } from '../../src/api/electrobunLink.ts';

const t = initTRPC.create();
const router = t.router({
  greeting: t.procedure
    .input(z.object({ name: z.string() }))
    .query(({ input }) => `Hello, ${input.name}`),
});

describe('Electrobun tRPC link', () => {
  test('uses Electrobun RPC only as the typed tRPC transport', async () => {
    const requests: Array<{ path: string; type: string; input: unknown }> = [];
    const client = createTRPCClient<typeof router>({
      links: [electrobunLink(async request => {
        requests.push(request);
        return { ok: true, data: `Hello, ${(request.input as { name: string }).name}` };
      })],
    });

    await expect(client.greeting.query({ name: 'Bun' })).resolves.toBe('Hello, Bun');
    expect(requests).toEqual([{
      path: 'greeting',
      type: 'query',
      input: { name: 'Bun' },
    }]);
  });

  test('reconstructs tRPC client errors returned across the bridge', async () => {
    const client = createTRPCClient<typeof router>({
      links: [electrobunLink(async () => ({
        ok: false,
        error: {
          message: 'Bridge procedure failed',
          code: -32603,
          data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'greeting' },
        },
      }))],
    });

    const error = await client.greeting.query({ name: 'Bun' }).catch(cause => cause);
    expect(error).toBeInstanceOf(TRPCClientError);
    expect(error.message).toBe('Bridge procedure failed');
    expect(error.data?.path).toBe('greeting');
  });
});
