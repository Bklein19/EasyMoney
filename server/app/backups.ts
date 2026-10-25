import path from 'node:path';
import { createDatabaseBackup, databaseBackupStatus, stageDatabaseRestore } from '../database.ts';
import { validateSnapshot } from '../databaseSnapshots.ts';
import { readBackupEntries } from '../backupRetention';

function backupPath(id: string) {
  if (!/^[a-zA-Z0-9.-]+\.sqlite(?:\.gz)?$/.test(id)) throw new Error('Invalid backup id.');
  return path.join(databaseBackupStatus().backupDirectory, id);
}

export function listBackups() {
  const status = databaseBackupStatus();
  const backups = readBackupEntries(status.backupDirectory);
  return { ...status, backups };
}

export function inspectBackup(id: string) {
  return validateSnapshot(backupPath(id));
}

export function restoreBackup(id: string) {
  return stageDatabaseRestore(backupPath(id));
}

export function createBackup() {
  return createDatabaseBackup();
}
