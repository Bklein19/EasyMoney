import fs from 'node:fs';
import path from 'node:path';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { initDatabase } from './database.js';
import { seedDatabase } from './seed.js';
import { loadLocalEnv } from './app/localEnv.ts';
import { appRouter } from './app/router.ts';
import index from '../index.html';

type RouteParams = Record<string, string>;
type AppRequest = Request & { params: RouteParams };
type RouteHandler = (request: AppRequest) => Response | Promise<Response>;
type RouteValue = Response | typeof index | RouteHandler | Record<string, RouteHandler | Response | typeof index>;
type RouteMap = Record<string, RouteValue>;

fs.mkdirSync(path.resolve(import.meta.dir, '..', 'data'), { recursive: true });

loadLocalEnv();
initDatabase();
seedDatabase();

const defaultPort = Number(process.env.PORT || 4177);

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function safe(handler: RouteHandler): RouteHandler {
  return async (request: AppRequest) => {
    try {
      return await handler(request);
    } catch (error) {
      console.error(error);
      return json({ error: error instanceof Error ? error.message : 'Internal server error' }, 500);
    }
  };
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

function wrapRouteValue(value: RouteValue): RouteValue {
  if (typeof value === 'function') return safe(value);
  if (!value || typeof value !== 'object') return value;

  const entries = Object.entries(value);
  if (!entries.some(([key]) => HTTP_METHODS.has(key))) return value;

  return Object.fromEntries(
    entries.map(([key, handler]) => [
      key,
      typeof handler === 'function' ? safe(handler) : handler,
    ])
  );
}

function wrapRoutes(routeMap: RouteMap) {
  return Object.fromEntries(
    Object.entries(routeMap).map(([route, value]) => [route, wrapRouteValue(value)])
  );
}

export const routes = wrapRoutes({
  '/': index,

  '/api/health': {
    GET: () => json({ ok: true }),
  },

  '/api/trpc/*': {
    GET: (request) => fetchRequestHandler({
      endpoint: '/api/trpc',
      req: request,
      router: appRouter,
      createContext: () => ({}),
    }),
    POST: (request) => fetchRequestHandler({
      endpoint: '/api/trpc',
      req: request,
      router: appRouter,
      createContext: () => ({}),
    }),
  },

  '/api/*': () => json({ error: 'Not found' }, 404),

  '/*': index,
});

export function createServer(options: { port?: number } = {}) {
  return Bun.serve({
    port: options.port ?? defaultPort,
    routes,
    development: { hmr: true, console: true },
  });
}

if (import.meta.main) {
  const server = createServer();
  console.log(`EasyMoney Bun server listening on http://localhost:${server.port}`);
}
