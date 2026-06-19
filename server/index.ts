import fs from 'node:fs';
import path from 'node:path';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import {
  assertTable,
  deleteRow,
  getDb,
  initDatabase,
  insertRow,
  insertRows,
  listRows,
  updateRow
} from './database.js';
import { seedDatabase } from './seed.js';
import { getLatestRobinhoodSnapshot, saveRobinhoodSnapshot } from './robinhoodSnapshots.js';
import { listAccounts } from './app/accounts.ts';
import { listCategories } from './app/categories.ts';
import { commitImport, listImportHistory, previewImport, unimportFile } from './app/imports.ts';
import { appRouter } from './app/router.ts';
import { splitTransactionAnnotationChanges, upsertTransactionAnnotation } from './app/transactionAnnotations.ts';
import { listTransactions } from './app/transactions.ts';
import index from '../index.html';

type RouteParams = Record<string, string>;
type AppRequest = Request & { params: RouteParams };
type RouteHandler = (request: AppRequest) => Response | Promise<Response>;
type RouteValue = Response | typeof index | RouteHandler | Record<string, RouteHandler | Response | typeof index>;
type RouteMap = Record<string, RouteValue>;

fs.mkdirSync(path.resolve(import.meta.dir, '..', 'data'), { recursive: true });

initDatabase();
seedDatabase();

const defaultPort = Number(process.env.PORT || process.env.VAULTVIEW_API_PORT || 4177);

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

async function bodyJson(request: Request): Promise<Record<string, any>> {
  if (request.headers.get('content-length') === '0') return {};
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function queryObject(request: Request) {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
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

  '/api/robinhood/snapshot': {
    GET: () => {
      const snapshot = getLatestRobinhoodSnapshot();
      if (!snapshot) {
        return json({
          connected: false,
          accounts: [],
          history: [],
          message: 'No Robinhood snapshot has been persisted yet.'
        });
      }

      return json({ connected: true, ...snapshot });
    },
    POST: async (request) => {
      const snapshotId = saveRobinhoodSnapshot(await bodyJson(request));
      return json({ id: snapshotId }, 201);
    },
  },

  '/api/app/accounts': {
    GET: () => json(listAccounts()),
  },

  '/api/app/categories': {
    GET: () => json(listCategories()),
  },

  '/api/app/transactions': {
    GET: (request) => json(listTransactions(queryObject(request))),
  },

  '/api/app/imports/preview': {
    POST: async (request) => {
      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') {
        return json({ error: 'CSV file is required' }, 400);
      }

      const customProfileJson = form.get('profileJson');
      const customProfile = typeof customProfileJson === 'string' && customProfileJson
        ? JSON.parse(customProfileJson)
        : null;
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      return json(await previewImport({
        fileName: file.name || 'import.csv',
        text: new TextDecoder().decode(fileBytes),
        fileBytes,
        customProfile,
      }));
    },
  },

  '/api/app/imports/commit': {
    POST: async (request) => json(commitImport(await bodyJson(request) as Parameters<typeof commitImport>[0]), 201),
  },

  '/api/app/imports': {
    GET: () => json({ imports: listImportHistory() }),
  },

  '/api/app/imports/:id': {
    DELETE: (request) => json(unimportFile(request.params.id)),
  },

  '/api/transactions/import-batch/:batchId': {
    DELETE: (request) => {
      const result = getDb().prepare('DELETE FROM transactions WHERE importBatchId = ?').run(request.params.batchId);
      return json({ count: result.changes });
    },
  },

  '/api/categories/:id/delete': {
    POST: (request) => {
      const db = getDb();
      const uncategorized = db.prepare("SELECT id FROM categories WHERE name = 'Uncategorized'").get() as { id: number } | undefined;
      const remove = db.transaction((id: number | string) => {
        if (uncategorized) {
          db.prepare('UPDATE transactionAnnotations SET categoryId = ? WHERE categoryId = ?').run(uncategorized.id, id);
        }
        db.prepare('DELETE FROM categorizationRules WHERE categoryId = ?').run(id);
        db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      });
      remove(request.params.id);
      return json({ ok: true });
    },
  },

  '/api/budgets/set': {
    POST: async (request) => {
      const { categoryId, month, amount } = await bodyJson(request);
      const db = getDb();
      const existing = db.prepare('SELECT id FROM budgets WHERE categoryId = ? AND month = ?').get(categoryId, month);
      if (existing && amount <= 0) {
        deleteRow('budgets', existing.id);
        return json({ ok: true });
      }
      if (existing) {
        updateRow('budgets', existing.id, { amount });
        return json({ id: existing.id });
      }
      if (amount <= 0) {
        return json({ ok: true });
      }
      const id = insertRow('budgets', { categoryId, month, amount });
      return json({ id }, 201);
    },
  },

  '/api/importProfiles/upsert': {
    POST: async (request) => {
      const now = new Date().toISOString();
      const { headerSignature, profileName, profileJson, mappingJson, lastAccountId } = await bodyJson(request);
      const db = getDb();
      const existing = db.prepare('SELECT id FROM importProfiles WHERE headerSignature = ?').get(headerSignature);

      if (existing) {
        updateRow('importProfiles', existing.id, {
          profileName,
          profileJson,
          mappingJson,
          lastAccountId,
          updatedAt: now
        });
        return json({ id: existing.id });
      }

      const id = insertRow('importProfiles', {
        headerSignature,
        profileName,
        profileJson,
        mappingJson,
        lastAccountId,
        createdAt: now,
        updatedAt: now
      });
      return json({ id }, 201);
    },
  },

  '/api/migrate': {
    POST: async (request) => {
      const db = getDb();
      const hasTransactions = (db.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count > 0;
      const hasAccounts = (db.prepare('SELECT COUNT(*) AS count FROM accounts').get() as { count: number }).count > 0;
      if (hasTransactions || hasAccounts) {
        return json({ skipped: true });
      }

      const payload = await bodyJson(request);
      const migrate = db.transaction(() => {
        for (const table of ['sourceBalances', 'sourceTransactions', 'sourceAccounts', 'sourceFiles', 'importRows', 'importFiles', 'transactionAnnotations', 'transactions', 'accountAliases', 'accounts', 'categories', 'budgets', 'balanceSnapshots', 'categorizationRules', 'importProfiles']) {
          db.prepare(`DELETE FROM ${table}`).run();
        }
        for (const table of ['accounts', 'accountAliases', 'categories', 'budgets', 'balanceSnapshots', 'categorizationRules', 'importProfiles', 'importFiles', 'importRows', 'sourceFiles', 'sourceAccounts', 'sourceTransactions', 'sourceBalances', 'transactions', 'transactionAnnotations']) {
          if (Array.isArray(payload[table]) && payload[table].length) {
            insertRows(table, payload[table], true);
          }
        }
      });
      migrate();
      seedDatabase();
      return json({ ok: true });
    },
  },

  '/api/:table': {
    GET: (request) => {
      const table = request.params.table;
      assertTable(table);
      return json(listRows(table, queryObject(request)));
    },
    POST: async (request) => {
      const table = request.params.table;
      assertTable(table);
      const id = insertRow(table, await bodyJson(request));
      return json({ id }, 201);
    },
  },

  '/api/:table/bulk': {
    POST: async (request) => {
      const table = request.params.table;
      assertTable(table);
      const body = await bodyJson(request);
      insertRows(table, body.rows || []);
      return json({ count: body.rows?.length || 0 }, 201);
    },
  },

  '/api/:table/:id': {
    PUT: async (request) => {
      const table = request.params.table;
      assertTable(table);
      const changes = await bodyJson(request);
      if (table === 'transactions') {
        const {
          transactionChanges,
          annotationChanges,
          hasAnnotationChanges,
        } = splitTransactionAnnotationChanges(changes);
        if (Object.keys(transactionChanges).length) {
          updateRow(table, request.params.id, transactionChanges);
        }
        if (hasAnnotationChanges) {
          upsertTransactionAnnotation(request.params.id, annotationChanges);
        }
      } else {
        updateRow(table, request.params.id, changes);
      }
      return json({ ok: true });
    },
    DELETE: (request) => {
      const table = request.params.table;
      assertTable(table);
      deleteRow(table, request.params.id);
      return json({ ok: true });
    },
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
