import fs from 'node:fs';
import path from 'node:path';
import { createDatabaseBackup, databaseBackupStatus, stageDatabaseRestore } from '../database.ts';
import { validateSnapshot } from '../databaseSnapshots.ts';

function backupPath(id: string) {
  if (!/^[a-zA-Z0-9.-]+\.sqlite$/.test(id)) throw new Error('Invalid backup id.');
  return path.join(databaseBackupStatus().backupDirectory, id);
}

export function listBackups() {
  const status = databaseBackupStatus();
  const backups = fs.existsSync(status.backupDirectory) ? fs.readdirSync(status.backupDirectory)
    .filter(id => id.endsWith('.sqlite'))
    .map(id => {
      const stat = fs.statSync(backupPath(id));
      return { id, size: stat.size, createdAt: stat.mtime.toISOString() };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  return { ...status, backups };
}

export function inspectBackup(id: string) {
  return validateSnapshot(backupPath(id));
}

export function restoreBackup(id: string) {
  return stageDatabaseRestore(backupPath(id));
}

export function createBackup() { return createDatabaseBackup(); }
