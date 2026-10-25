import fs from 'node:fs';
import path from 'node:path';
import { compressSnapshot, validateSnapshot } from './databaseSnapshots';

export const BACKUP_RETENTION = { recent: 3, olderWeeks: 4 } as const;

export interface BackupEntry {
  id: string;
  size: number;
  createdAt: string;
  automatic: boolean;
}

export function readBackupEntries(directory: string): BackupEntry[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .flatMap((id) => {
      if (!/^[a-zA-Z0-9.-]+\.sqlite(?:\.gz)?$/.test(id)) return [];
      const stat = fs.lstatSync(path.join(directory, id));
      if (!stat.isFile() || stat.isSymbolicLink()) return [];
      const match =
        /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.sqlite(?:\.gz)?$/.exec(
          id,
        );
      const timestamp = match?.[1]?.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
      const validTimestamp = timestamp && Number.isFinite(Date.parse(timestamp));
      const reason = match?.[2];
      return [
        {
          id,
          size: stat.size,
          createdAt: validTimestamp ? timestamp : stat.mtime.toISOString(),
          // Unknown/imported names and explicit restore safety copies are never auto-pruned.
          automatic: Boolean(
            validTimestamp && reason?.startsWith('before-') && reason !== 'before-restore',
          ),
        },
      ];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function weekKey(createdAt: string) {
  const date = new Date(createdAt);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function planBackupRetention(directory: string) {
  const entries = readBackupEntries(directory);
  const key = (entry: BackupEntry) => entry.id.replace(/\.gz$/, '');
  const automatic = entries.filter(
    (entry, index) =>
      entry.automatic && entries.findIndex((candidate) => key(candidate) === key(entry)) === index,
  );
  const keepIds = new Set(automatic.slice(0, BACKUP_RETENTION.recent).map(key));
  const weeks = new Set(
    automatic.slice(0, BACKUP_RETENTION.recent).map((entry) => weekKey(entry.createdAt)),
  );
  let olderWeeks = 0;
  for (const entry of automatic.slice(BACKUP_RETENTION.recent)) {
    const week = weekKey(entry.createdAt);
    if (!weeks.has(week) && olderWeeks < BACKUP_RETENTION.olderWeeks) {
      weeks.add(week);
      olderWeeks++;
      keepIds.add(key(entry));
    }
  }
  const oldest = automatic.at(-1);
  if (oldest) keepIds.add(key(oldest));
  return {
    directory,
    keep: entries.filter((entry) => !entry.automatic || keepIds.has(key(entry))),
    remove: entries.filter((entry) => entry.automatic && !keepIds.has(key(entry))),
  };
}

/** Never follow symlinks or prune until every selected recovery copy has passed validation. */
export function maintainBackupDirectory(directory: string, options: { compress?: boolean } = {}) {
  const plan = planBackupRetention(directory);
  if (!options.compress && !plan.remove.length) return { ...plan, reclaimedBytes: 0 };
  const identities = [...plan.keep, ...plan.remove].map((entry) => {
    const stat = fs.lstatSync(path.join(directory, entry.id));
    return { entry, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  for (const entry of plan.keep) validateSnapshot(path.join(directory, entry.id));
  const beforeBytes = readBackupEntries(directory).reduce((total, entry) => total + entry.size, 0);
  for (const { entry, ino, size, mtimeMs } of identities) {
    const stat = fs.lstatSync(path.join(directory, entry.id));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.ino !== ino ||
      stat.size !== size ||
      stat.mtimeMs !== mtimeMs
    )
      throw new Error('Backup directory changed during maintenance; pruning cancelled.');
  }
  // Finish and verify all compression before removing any obsolete checkpoints.
  if (options.compress) {
    for (const entry of plan.keep) {
      if (!entry.id.endsWith('.sqlite')) continue;
      compressSnapshot(path.join(directory, entry.id));
    }
  }
  for (const entry of plan.remove) {
    const expected = identities.find((identity) => identity.entry.id === entry.id)!;
    const current = fs.lstatSync(path.join(directory, entry.id));
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.ino !== expected.ino ||
      current.size !== expected.size ||
      current.mtimeMs !== expected.mtimeMs
    )
      throw new Error('Backup changed during maintenance; remaining checkpoints retained.');
    fs.unlinkSync(path.join(directory, entry.id));
  }
  const afterBytes = readBackupEntries(directory).reduce((total, entry) => total + entry.size, 0);
  return { ...plan, reclaimedBytes: beforeBytes - afterBytes };
}
