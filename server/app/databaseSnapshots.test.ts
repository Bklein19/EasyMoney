import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSnapshot, writeSnapshot, selectedDatabasePath } from '../databaseSnapshots';

test('validated snapshots preserve committed WAL data and leave the live database untouched', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-snapshot-'));
  const source = new Database(path.join(directory, 'live.sqlite'));
  try {
    source.exec('PRAGMA journal_mode=WAL');
    for (const table of ['accounts', 'sourceFiles', 'sourceAccounts', 'sourceTransactions', 'sourceBalances', 'transactionAnnotations', 'ledgerTransactions', 'budgetPlans']) {
      source.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT)`);
      source.query(`INSERT INTO ${table} VALUES (1, ?)`).run(`preserved-${table}`);
    }
    const backup = writeSnapshot(source, directory, 'test');
    expect(validateSnapshot(backup.path)).toEqual({ accounts: 1, files: 1, transactions: 1, annotations: 1 });
    source.query('UPDATE budgetPlans SET value = ?').run('newer');
    const snapshot = new Database(backup.path, { readonly: true });
    try { expect(snapshot.query('SELECT value FROM budgetPlans').get()).toEqual({ value: 'preserved-budgetPlans' }); }
    finally { snapshot.close(); }
    expect(source.query('SELECT value FROM budgetPlans').get()).toEqual({ value: 'newer' });
  } finally { source.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('restore rejects unrelated databases, corrupt files and paths outside its directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-invalid-backup-'));
  try {
    const file = path.join(directory, 'invalid.sqlite');
    const database = new Database(file); database.exec('CREATE TABLE unrelated (id INTEGER)'); database.close();
    expect(() => validateSnapshot(file)).toThrow('Not an EasyMoney backup');
    fs.writeFileSync(file, 'not a sqlite file');
    expect(() => validateSnapshot(file)).toThrow();
    fs.writeFileSync(`${file}.restore.json`, JSON.stringify({ fileName: '../other.sqlite' }));
    expect(() => selectedDatabasePath(file)).toThrow('Invalid database restore selection');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
