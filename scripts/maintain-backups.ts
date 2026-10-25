import path from 'node:path';
import { maintainBackupDirectory, planBackupRetention } from '../server/backupRetention';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const directories = args.filter((arg) => arg !== '--apply');
if (!directories.length || directories.some((directory) => directory.startsWith('-'))) {
  throw new Error('Usage: bun scripts/maintain-backups.ts [--apply] <backup-directory> [...]');
}
for (const directory of directories.map((directory) => path.resolve(directory))) {
  const plan = planBackupRetention(directory);
  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'preview',
        directory,
        keep: plan.keep.map(({ id }) => id),
        remove: plan.remove.map(({ id }) => id),
        pruneBytes: plan.remove.reduce((total, entry) => total + entry.size, 0),
      },
      null,
      2,
    ),
  );
  if (apply) {
    const result = maintainBackupDirectory(directory, { compress: true });
    console.log(JSON.stringify({ directory, reclaimedBytes: result.reclaimedBytes }));
  }
}
