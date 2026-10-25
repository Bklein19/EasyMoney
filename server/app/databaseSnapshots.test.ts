import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateSnapshot,
  writeSnapshot,
  selectedDatabasePath,
  withSnapshotFile,
  compressSnapshot,
} from '../databaseSnapshots';
import { gunzipSync } from 'node:zlib';

test('validated snapshots preserve committed WAL data and leave the live database untouched', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-snapshot-'));
  const source = new Database(path.join(directory, 'live.sqlite'));
  try {
    source.exec('PRAGMA journal_mode=WAL');
    for (const table of [
      'accounts',
      'sourceFiles',
      'sourceAccounts',
      'sourceTransactions',
      'sourceBalances',
      'transactionAnnotations',
      'ledgerTransactions',
      'budgetPlans',
    ]) {
      source.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT)`);
      source.query(`INSERT INTO ${table} VALUES (1, ?)`).run(`preserved-${table}`);
    }
    const backup = writeSnapshot(source, directory, 'test');
    expect(validateSnapshot(backup.path)).toEqual({
      accounts: 1,
      files: 1,
      transactions: 1,
      annotations: 1,
    });
    source.query('UPDATE budgetPlans SET value = ?').run('newer');
    expect(backup.id.endsWith('.sqlite.gz')).toBe(true);
    expect(fs.statSync(backup.path).mode & 0o777).toBe(0o600);
    withSnapshotFile(backup.path, (file) => {
      const snapshot = new Database(file, { readonly: true });
      try {
        expect(snapshot.query('SELECT value FROM budgetPlans').get()).toEqual({
          value: 'preserved-budgetPlans',
        });
      } finally {
        snapshot.close();
      }
    });
    const legacyPath = path.join(directory, 'legacy.sqlite');
    fs.writeFileSync(legacyPath, gunzipSync(fs.readFileSync(backup.path)));
    expect(validateSnapshot(legacyPath).accounts).toBe(1);
    const original = fs.readFileSync(legacyPath);
    const compressed = compressSnapshot(legacyPath);
    expect(gunzipSync(fs.readFileSync(compressed))).toEqual(original);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(source.query('SELECT value FROM budgetPlans').get()).toEqual({ value: 'newer' });
  } finally {
    source.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('restore rejects unrelated databases, corrupt files and paths outside its directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-invalid-backup-'));
  try {
    const file = path.join(directory, 'invalid.sqlite');
    const database = new Database(file);
    database.exec('CREATE TABLE unrelated (id INTEGER)');
    database.close();
    expect(() => validateSnapshot(file)).toThrow('Not an EasyMoney backup');
    fs.writeFileSync(file, 'not a sqlite file');
    expect(() => validateSnapshot(file)).toThrow();
    fs.writeFileSync(`${file}.gz`, 'invalid gzip');
    expect(() => validateSnapshot(`${file}.gz`)).toThrow();
    fs.writeFileSync(`${file}.restore.json`, JSON.stringify({ fileName: '../other.sqlite' }));
    expect(() => selectedDatabasePath(file)).toThrow('Invalid database restore selection');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
