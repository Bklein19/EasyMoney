import express from 'express';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.resolve(__dirname, '..', 'data'), { recursive: true });

initDatabase();
seedDatabase();

const app = express();
const port = Number(process.env.VAULTVIEW_API_PORT || 4177);

app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/:table', (req, res, next) => {
  try {
    assertTable(req.params.table);
    res.json(listRows(req.params.table, req.query));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:table', (req, res, next) => {
  try {
    assertTable(req.params.table);
    const id = insertRow(req.params.table, req.body);
    res.status(201).json({ id });
  } catch (error) {
    next(error);
  }
});

app.post('/api/:table/bulk', (req, res, next) => {
  try {
    assertTable(req.params.table);
    insertRows(req.params.table, req.body.rows || []);
    res.status(201).json({ count: req.body.rows?.length || 0 });
  } catch (error) {
    next(error);
  }
});

app.put('/api/:table/:id', (req, res, next) => {
  try {
    assertTable(req.params.table);
    updateRow(req.params.table, req.params.id, req.body);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:table/:id', (req, res, next) => {
  try {
    assertTable(req.params.table);
    deleteRow(req.params.table, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/accounts/:id/deep', (req, res, next) => {
  try {
    const db = getDb();
    const remove = db.transaction((id) => {
      db.prepare('DELETE FROM transactions WHERE accountId = ?').run(id);
      db.prepare('DELETE FROM balanceSnapshots WHERE accountId = ?').run(id);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    });
    remove(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/transactions/import-batch/:batchId', (req, res, next) => {
  try {
    const result = getDb().prepare('DELETE FROM transactions WHERE importBatchId = ?').run(req.params.batchId);
    res.json({ count: result.changes });
  } catch (error) {
    next(error);
  }
});

app.post('/api/categories/:id/delete', (req, res, next) => {
  try {
    const db = getDb();
    const uncategorized = db.prepare("SELECT id FROM categories WHERE name = 'Uncategorized'").get();
    const remove = db.transaction((id) => {
      if (uncategorized) {
        db.prepare('UPDATE transactions SET categoryId = ? WHERE categoryId = ?').run(uncategorized.id, id);
      }
      db.prepare('DELETE FROM categorizationRules WHERE categoryId = ?').run(id);
      db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    });
    remove(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/budgets/set', (req, res, next) => {
  try {
    const { categoryId, month, amount } = req.body;
    const db = getDb();
    const existing = db.prepare('SELECT id FROM budgets WHERE categoryId = ? AND month = ?').get(categoryId, month);
    if (existing && amount <= 0) {
      deleteRow('budgets', existing.id);
      res.json({ ok: true });
      return;
    }
    if (existing) {
      updateRow('budgets', existing.id, { amount });
      res.json({ id: existing.id });
      return;
    }
    if (amount <= 0) {
      res.json({ ok: true });
      return;
    }
    const id = insertRow('budgets', { categoryId, month, amount });
    res.status(201).json({ id });
  } catch (error) {
    next(error);
  }
});

app.post('/api/importProfiles/upsert', (req, res, next) => {
  try {
    const now = new Date().toISOString();
    const { headerSignature, profileName, profileJson, mappingJson, lastAccountId } = req.body;
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
      res.json({ id: existing.id });
      return;
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
    res.status(201).json({ id });
  } catch (error) {
    next(error);
  }
});

app.post('/api/migrate', (req, res, next) => {
  try {
    const db = getDb();
    const hasTransactions = db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count > 0;
    const hasAccounts = db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count > 0;
    if (hasTransactions || hasAccounts) {
      res.json({ skipped: true });
      return;
    }

    const payload = req.body || {};
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
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res) => {
  console.error(error);
  res.status(500).json({ error: error.message });
});

app.listen(port, () => {
  console.log(`EasyMoney local SQLite API listening on http://localhost:${port}`);
});
