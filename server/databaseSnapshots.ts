import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { hashContent } from './hash';

export function flushSnapshotFile(filePath: string) {
  const descriptor = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** The callback must finish synchronously; extracted private files never outlive it. */
export function withSnapshotFile<T>(filePath: string, use: (filePath: string) => T): T {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Backup must be a regular file.');
  if (!filePath.endsWith('.gz')) return use(filePath);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-backup-read-'));
  try {
    const extracted = path.join(directory, 'snapshot.sqlite');
    fs.writeFileSync(extracted, gunzipSync(fs.readFileSync(filePath)), { mode: 0o600 });
    return use(extracted);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function validateSnapshot(filePath: string) {
  return withSnapshotFile(filePath, validateUncompressedSnapshot);
}

function validateUncompressedSnapshot(filePath: string) {
  const candidate = new Database(filePath, { readonly: true });
  try {
    const result = candidate.query('PRAGMA quick_check').get() as { quick_check: string };
    if (result.quick_check !== 'ok') throw new Error('Database integrity check failed.');
    const tables = candidate.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    for (const required of [
      'accounts',
      'sourceFiles',
      'sourceAccounts',
      'sourceTransactions',
      'sourceBalances',
      'transactionAnnotations',
      'ledgerTransactions',
    ]) {
      if (!tables.some((table) => table.name === required))
        throw new Error(`Not an EasyMoney backup: missing ${required}.`);
    }
    if (candidate.query('PRAGMA foreign_key_check').all().length)
      throw new Error('Backup contains broken account or source references.');
    const count = (table: string) =>
      (candidate.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return {
      accounts: count('accounts'),
      files: count('sourceFiles'),
      transactions: count('ledgerTransactions'),
      annotations: count('transactionAnnotations'),
    };
  } finally {
    candidate.close();
  }
}

function flushDirectory(directory: string) {
  // Windows does not expose directory fsync through the filesystem API.
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeCompressedSnapshot(source: string, destination: string) {
  const bytes = fs.readFileSync(source);
  const expectedHash = hashContent(bytes);
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Backup must be a regular file.');
    if (hashContent(gunzipSync(fs.readFileSync(destination))) !== expectedHash)
      throw new Error('Compressed backup already exists with different contents.');
    flushSnapshotFile(destination);
    flushDirectory(path.dirname(destination));
    return;
  }
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, gzipSync(bytes, { level: 1 }), { mode: 0o600, flag: 'wx' });
    if (hashContent(gunzipSync(fs.readFileSync(temporary))) !== expectedHash)
      throw new Error('Compressed backup verification failed.');
    flushSnapshotFile(temporary);
    // Publish without replacing a pre-existing recovery checkpoint.
    fs.linkSync(temporary, destination);
    flushDirectory(path.dirname(destination));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Replace a legacy snapshot only after validating a byte-identical compressed copy. */
export function compressSnapshot(filePath: string) {
  if (!filePath.endsWith('.sqlite')) throw new Error('Expected an uncompressed SQLite backup.');
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error('Backup must be a regular file.');
  if (
    ['-wal', '-journal'].some(
      (suffix) =>
        fs.existsSync(`${filePath}${suffix}`) && fs.statSync(`${filePath}${suffix}`).size > 0,
    )
  )
    throw new Error('Backup has a journal sidecar; original retained.');
  validateSnapshot(filePath);
  const destination = `${filePath}.gz`;
  writeCompressedSnapshot(filePath, destination);
  const after = fs.lstatSync(filePath);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error('Backup changed during compression; original retained.');
  fs.utimesSync(destination, before.atime, before.mtime);
  fs.unlinkSync(filePath);
  flushDirectory(path.dirname(filePath));
  return destination;
}

function makeSnapshotPortable(filePath: string) {
  const candidate = new Database(filePath);
  try {
    const result = candidate.query('PRAGMA journal_mode = DELETE').get() as {
      journal_mode: string;
    };
    if (result.journal_mode !== 'delete')
      throw new Error('Could not finalize the database backup.');
  } finally {
    candidate.close();
  }
}

export function writeSnapshot(database: Database, directory: string, reason: string) {
  fs.mkdirSync(directory, { recursive: true });
  if (!/^[a-zA-Z0-9.-]+$/.test(reason)) throw new Error('Invalid backup reason.');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}-${crypto.randomUUID()}.sqlite.gz`;
  const destination = path.join(directory, id);
  const temporary = `${destination}.tmp`;
  try {
    fs.writeFileSync(temporary, database.serialize(), { mode: 0o600, flag: 'wx' });
    makeSnapshotPortable(temporary);
    validateSnapshot(temporary);
    flushSnapshotFile(temporary);
    writeCompressedSnapshot(temporary, destination);
    return { id, path: destination };
  } finally {
    for (const candidate of [temporary, `${temporary}-wal`, `${temporary}-shm`]) {
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
  }
}

// A restore selects a separate database on the next launch. The original and its WAL stay intact.
export function selectedDatabasePath(basePath: string) {
  const pointer = `${basePath}.restore.json`;
  if (!fs.existsSync(pointer)) return basePath;
  const value: unknown = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    !('fileName' in value) ||
    typeof value.fileName !== 'string' ||
    !/^restored-[a-f0-9-]+\.sqlite$/.test(value.fileName)
  )
    throw new Error('Invalid database restore selection.');
  const selected = path.join(path.dirname(basePath), value.fileName);
  validateSnapshot(selected);
  return selected;
}
