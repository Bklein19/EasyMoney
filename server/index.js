import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.resolve(__dirname, '..', 'data'), { recursive: true });

initDatabase();
seedDatabase();

const port = Number(process.env.PORT || process.env.VAULTVIEW_API_PORT || 4177);
const distPath = path.resolve(__dirname, '..', 'dist');

function json(data, status = 200) {
  return Response.json(data, { status });
}

async function bodyJson(request) {
  if (request.headers.get('content-length') === '0') return {};
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

function pathParts(url) {
  return url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
}

async function handleApi(request, url) {
  const parts = pathParts(url);
  const method = request.method;

  if (method === 'GET' && url.pathname === '/api/health') {
    return json({ ok: true });
  }

  if (url.pathname === '/api/robinhood/snapshot') {
    if (method === 'GET') {
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
    }

    if (method === 'POST') {
      const snapshotId = saveRobinhoodSnapshot(await bodyJson(request));
      return json({ id: snapshotId }, 201);
    }
  }

  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'accounts' && parts[3] === 'deep') {
    const db = getDb();
    const remove = db.transaction((id) => {
      db.prepare('DELETE FROM transactions WHERE accountId = ?').run(id);
      db.prepare('DELETE FROM balanceSnapshots WHERE accountId = ?').run(id);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    });
    remove(parts[2]);
    return json({ ok: true });
  }

  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'transactions' && parts[2] === 'import-batch') {
    const result = getDb().prepare('DELETE FROM transactions WHERE importBatchId = ?').run(parts[3]);
    return json({ count: result.changes });
  }

  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'categories' && parts[3] === 'delete') {
    const db = getDb();
    const uncategorized = db.prepare("SELECT id FROM categories WHERE name = 'Uncategorized'").get();
    const remove = db.transaction((id) => {
      if (uncategorized) {
        db.prepare('UPDATE transactions SET categoryId = ? WHERE categoryId = ?').run(uncategorized.id, id);
      }
      db.prepare('DELETE FROM categorizationRules WHERE categoryId = ?').run(id);
      db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    });
    remove(parts[2]);
    return json({ ok: true });
  }

  if (method === 'POST' && url.pathname === '/api/budgets/set') {
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
  }

  if (method === 'POST' && url.pathname === '/api/importProfiles/upsert') {
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
  }

  if (method === 'POST' && url.pathname === '/api/migrate') {
    const db = getDb();
    const hasTransactions = db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count > 0;
    const hasAccounts = db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count > 0;
    if (hasTransactions || hasAccounts) {
      return json({ skipped: true });
    }

    const payload = await bodyJson(request);
    const migrate = db.transaction(() => {
      for (const table of ['transactions', 'accounts', 'categories', 'budgets', 'balanceSnapshots', 'categorizationRules', 'importProfiles']) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
      for (const table of ['accounts', 'categories', 'budgets', 'balanceSnapshots', 'categorizationRules', 'importProfiles', 'transactions']) {
        if (Array.isArray(payload[table]) && payload[table].length) {
          insertRows(table, payload[table], true);
        }
      }
    });
    migrate();
    seedDatabase();
    return json({ ok: true });
  }

  if (parts[0] === 'api' && parts.length === 2 && method === 'GET') {
    const table = parts[1];
    assertTable(table);
    return json(listRows(table, queryObject(url)));
  }

  if (parts[0] === 'api' && parts.length === 2 && method === 'POST') {
    const table = parts[1];
    assertTable(table);
    const id = insertRow(table, await bodyJson(request));
    return json({ id }, 201);
  }

  if (parts[0] === 'api' && parts.length === 3 && parts[2] === 'bulk' && method === 'POST') {
    const table = parts[1];
    assertTable(table);
    const body = await bodyJson(request);
    insertRows(table, body.rows || []);
    return json({ count: body.rows?.length || 0 }, 201);
  }

  if (parts[0] === 'api' && parts.length === 3 && method === 'PUT') {
    const table = parts[1];
    assertTable(table);
    updateRow(table, parts[2], await bodyJson(request));
    return json({ ok: true });
  }

  if (parts[0] === 'api' && parts.length === 3 && method === 'DELETE') {
    const table = parts[1];
    assertTable(table);
    deleteRow(table, parts[2]);
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

function staticResponse(url) {
  if (!fs.existsSync(distPath)) return null;

  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const requestedPath = path.resolve(distPath, `.${pathname}`);
  if (!requestedPath.startsWith(`${distPath}${path.sep}`) && requestedPath !== distPath) {
    return json({ error: 'Not found' }, 404);
  }

  if (fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()) {
    return new Response(Bun.file(requestedPath));
  }

  if (url.pathname.startsWith('/api')) return null;

  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    return new Response(Bun.file(indexPath), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  return null;
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/api')) {
        return await handleApi(request, url);
      }

      return staticResponse(url) ?? json({ error: 'Not found' }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: error.message }, 500);
    }
  }
});

console.log(`EasyMoney Bun server listening on http://localhost:${port}`);
