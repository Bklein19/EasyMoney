import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('restore switches databases after restart, preserves annotations and plans, and retains the previous database', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-restore-cycle-'));
  const databasePath = path.join(directory, 'live.sqlite');
  const imports = `
    const dbModule = await import(${JSON.stringify(new URL('../database.ts', import.meta.url).href)});
    const { initDatabase, getDb, insertRow, closeDatabase, databaseBackupStatus } = dbModule;
    const { appRouter } = await import(${JSON.stringify(new URL('./router.ts', import.meta.url).href)});
    const caller = appRouter.createCaller({});
    initDatabase();
  `;
  const run = (code: string) => {
    const child = Bun.spawnSync([process.execPath, '--eval', imports + code], {
      env: { ...process.env, EASYMONEY_DB_PATH: databasePath, EASYMONEY_ENV_PATH: path.join(directory, '.env.local'), NODE_ENV: 'test' },
      stdout: 'pipe', stderr: 'pipe', timeout: 15000,
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString());
  };
  try {
    const stage = run(`
      const accountId = insertRow('accounts', { name: 'Before backup', type: 'checking' });
      const sourceFileId = insertRow('sourceFiles', { fileName: 'source.csv', contentHash: 'source', status: 'committed' });
      insertRow('sourceAccounts', { sourceFileId, accountId, sourceAccountKey: 'checking' });
      insertRow('transactionAnnotations', { ledgerTransactionId: 'txn_preserved', notes: 'Keep this note' });
      await caller.budgets.migratePlans({ globalBudgets: { 'year:2026': 1200 }, dreamBudget: { globalBudget: 100, categoryPercents: {} }, savedBudgets: [] });
      const backup = await caller.backups.create();
      getDb().prepare('UPDATE accounts SET name = ? WHERE id = ?').run('After backup', accountId);
      const restored = await caller.backups.restore({ id: backup.id });
      let blocked = false;
      try { await caller.accounts.updateMetadata({ id: accountId, changes: { name: 'Should be blocked' } }); } catch { blocked = true; }
      console.log(JSON.stringify({ blocked, pending: databaseBackupStatus().restorePending, restored }));
      closeDatabase();
    `);
    expect(stage.blocked).toBe(true);
    expect(stage.pending).toBe(true);
    expect(fs.existsSync(stage.restored.beforeRestore.path)).toBe(true);
    expect(fs.existsSync(`${stage.restored.beforeRestore.path}-wal`)).toBe(false);
    expect(fs.existsSync(`${stage.restored.beforeRestore.path}-shm`)).toBe(false);
    const portableBackup = new Database(stage.restored.beforeRestore.path, { readonly: true });
    try { expect(portableBackup.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' }); }
    finally { portableBackup.close(); }
    const original = new Database(databasePath, { readonly: true });
    try { expect(original.query('SELECT name FROM accounts').get()).toEqual({ name: 'After backup' }); }
    finally { original.close(); }
    const reopened = run(`
      console.log(JSON.stringify({ status: databaseBackupStatus(), plans: await caller.budgets.plans(),
        account: getDb().prepare('SELECT name FROM accounts').get(),
        note: getDb().prepare('SELECT notes FROM transactionAnnotations').get(),
        mapping: getDb().prepare('SELECT accountId FROM sourceAccounts').get() }));
      closeDatabase();
    `);
    expect(reopened.status.restorePending).toBe(false);
    expect(reopened.status.databasePath).not.toBe(databasePath);
    expect(reopened.account.name).toBe('Before backup');
    expect(reopened.note.notes).toBe('Keep this note');
    expect(reopened.mapping.accountId).toBe(1);
    expect(reopened.plans.plans.globalBudgets['year:2026']).toBe(1200);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
