import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function flushSnapshotFile(filePath: string) {
  const descriptor = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export function validateSnapshot(filePath: string) {
  const candidate = new Database(filePath, { readonly: true });
  try {
    const result = candidate.query('PRAGMA quick_check').get() as { quick_check: string };
    if (result.quick_check !== 'ok') throw new Error('Database integrity check failed.');
    const tables = candidate.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    for (const required of ['accounts', 'sourceFiles', 'sourceAccounts', 'sourceTransactions', 'sourceBalances', 'transactionAnnotations', 'ledgerTransactions']) {
      if (!tables.some(table => table.name === required)) throw new Error(`Not an EasyMoney backup: missing ${required}.`);
    }
    if (candidate.query('PRAGMA foreign_key_check').all().length) throw new Error('Backup contains broken account or source references.');
    const count = (table: string) => (candidate.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return { accounts: count('accounts'), files: count('sourceFiles'), transactions: count('ledgerTransactions'), annotations: count('transactionAnnotations') };
  } finally {
    candidate.close();
  }
}

export function writeSnapshot(database: Database, directory: string, reason: string) {
  fs.mkdirSync(directory, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}-${crypto.randomUUID()}.sqlite`;
  const destination = path.join(directory, id);
  const temporary = `${destination}.tmp`;
  try {
    fs.writeFileSync(temporary, database.serialize(), { mode: 0o600, flag: 'wx' });
    validateSnapshot(temporary);
    flushSnapshotFile(temporary);
    fs.renameSync(temporary, destination);
    return { id, path: destination };
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

// A restore selects a separate database on the next launch. The original and its WAL stay intact.
export function selectedDatabasePath(basePath: string) {
  const pointer = `${basePath}.restore.json`;
  if (!fs.existsSync(pointer)) return basePath;
  const value: unknown = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  if (!value || typeof value !== 'object' || !('fileName' in value) || typeof value.fileName !== 'string' ||
      !/^restored-[a-f0-9-]+\.sqlite$/.test(value.fileName)) throw new Error('Invalid database restore selection.');
  const selected = path.join(path.dirname(basePath), value.fileName);
  validateSnapshot(selected);
  return selected;
}
