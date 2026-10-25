import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  maintainBackupDirectory,
  planBackupRetention,
  readBackupEntries,
} from '../backupRetention';
import { compressSnapshot, validateSnapshot } from '../databaseSnapshots';

const id = (day: string, reason = 'before-migration') =>
  `${day}T00-00-00-000Z-${reason}-00000000-0000-0000-0000-000000000000.sqlite`;

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-retention-'));
  const source = new Database(':memory:');
  for (const table of [
    'accounts',
    'sourceFiles',
    'sourceAccounts',
    'sourceTransactions',
    'sourceBalances',
    'transactionAnnotations',
    'ledgerTransactions',
    'importOriginals',
  ]) {
    source.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value BLOB)`);
    source.query(`INSERT INTO ${table} VALUES (1, ?)`).run(new Uint8Array([1, 2, 3]));
  }
  const bytes = Buffer.from(source.serialize());
  source.close();
  const write = (name: string) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return file;
  };
  return {
    directory,
    bytes,
    write,
    close: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test('retention keeps recent, distinct older weekly and oldest automatic checkpoints without trusting mtime', () => {
  const f = fixture();
  try {
    const days = [
      '01',
      '02',
      '03',
      '05',
      '06',
      '12',
      '13',
      '19',
      '20',
      '26',
      '27',
      '28',
      '29',
      '30',
      '31',
    ];
    for (const day of days) f.write(id(`2026-10-${day}`));
    f.write(id('2026-08-01'));
    const manual = id('2026-07-01', 'manual');
    const preRestore = id('2026-07-02', 'before-restore');
    const custom = 'imported-checkpoint.sqlite';
    for (const name of [manual, preRestore, custom]) f.write(name);
    fs.writeFileSync(path.join(f.directory, 'unrelated.txt'), 'leave alone');
    fs.symlinkSync(path.join(f.directory, manual), path.join(f.directory, id('2025-01-01')));
    const plan = planBackupRetention(f.directory);
    expect(plan.keep.filter((entry) => entry.automatic).map((entry) => entry.id)).toEqual(
      ['31', '30', '29', '20', '13', '06', '03']
        .map((day) => id(`2026-10-${day}`))
        .concat(id('2026-08-01')),
    );
    expect(plan.keep.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([manual, preRestore, custom]),
    );
    expect(plan.remove.every((entry) => entry.automatic)).toBe(true);
    expect(readBackupEntries(f.directory).some((entry) => entry.id === id('2025-01-01'))).toBe(
      false,
    );
    const result = maintainBackupDirectory(f.directory, { compress: true });
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    for (const entry of plan.keep) {
      expect(fs.existsSync(path.join(f.directory, `${entry.id}.gz`))).toBe(true);
      expect(validateSnapshot(path.join(f.directory, `${entry.id}.gz`)).annotations).toBe(1);
      expect(gunzipSync(fs.readFileSync(path.join(f.directory, `${entry.id}.gz`)))).toEqual(
        f.bytes,
      );
    }
    for (const entry of plan.remove)
      expect(fs.existsSync(path.join(f.directory, entry.id))).toBe(false);
    expect(fs.readFileSync(path.join(f.directory, 'unrelated.txt'), 'utf8')).toBe('leave alone');
    expect(fs.lstatSync(path.join(f.directory, id('2025-01-01'))).isSymbolicLink()).toBe(true);
    expect(maintainBackupDirectory(f.directory, { compress: true }).reclaimedBytes).toBe(0);
  } finally {
    f.close();
  }
});

test('corrupt retained backups prevent compression and all pruning', () => {
  const f = fixture();
  try {
    for (const day of ['01', '02', '03', '04', '05', '06']) f.write(id(`2026-10-${day}`));
    fs.writeFileSync(path.join(f.directory, id('2026-10-06')), 'corrupt');
    const before = fs.readdirSync(f.directory);
    expect(planBackupRetention(f.directory).remove.length).toBeGreaterThan(0);
    expect(() => maintainBackupDirectory(f.directory, { compress: true })).toThrow();
    expect(fs.readdirSync(f.directory)).toEqual(before);
  } finally {
    f.close();
  }
});

test('compression refuses conflicting destinations and leaves original and obsolete backups intact', () => {
  const f = fixture();
  try {
    for (const day of ['01', '02', '03', '04', '05', '06']) f.write(id(`2026-10-${day}`));
    const file = path.join(f.directory, id('2026-10-06'));
    fs.writeFileSync(`${file}.gz`, gzipSync(Buffer.from('different contents')));
    expect(() => compressSnapshot(file)).toThrow('different contents');
    expect(fs.readFileSync(file)).toEqual(f.bytes);
    const before = fs.readdirSync(f.directory);
    expect(() => maintainBackupDirectory(f.directory, { compress: true })).toThrow();
    expect(fs.readdirSync(f.directory)).toEqual(before);
  } finally {
    f.close();
  }
});

test('interrupted compression with both formats never prunes a kept compressed checkpoint', () => {
  const f = fixture();
  try {
    for (const day of ['01', '02', '03', '04', '05', '06']) {
      const file = f.write(id(`2026-10-${day}`));
      fs.writeFileSync(`${file}.gz`, gzipSync(f.bytes));
    }
    const plan = planBackupRetention(f.directory);
    const kept = new Set(plan.keep.map((entry) => entry.id.replace(/\.gz$/, '')));
    const result = maintainBackupDirectory(f.directory, { compress: true });
    expect(readBackupEntries(f.directory).length).toBe(kept.size);
    for (const name of kept) {
      expect(fs.existsSync(path.join(f.directory, `${name}.gz`))).toBe(true);
      expect(validateSnapshot(path.join(f.directory, `${name}.gz`)).files).toBe(1);
    }
    const finalBytes = readBackupEntries(f.directory).reduce(
      (total, entry) => total + entry.size,
      0,
    );
    expect(result.reclaimedBytes).toBe(
      6 * (f.bytes.length + gzipSync(f.bytes).length) - finalBytes,
    );
  } finally {
    f.close();
  }
});

test('newest gzip timestamps come from their names and malformed automatic-looking names stay protected', () => {
  const f = fixture();
  try {
    const file = f.write(id('2026-10-01'));
    compressSnapshot(file);
    fs.utimesSync(`${file}.gz`, new Date(), new Date('2030-01-01'));
    f.write('before-migration.sqlite');
    expect(
      readBackupEntries(f.directory).find((entry) => entry.id.endsWith('.gz'))?.createdAt,
    ).toBe('2026-10-01T00:00:00.000Z');
    expect(
      readBackupEntries(f.directory).find((entry) => entry.id === 'before-migration.sqlite')
        ?.automatic,
    ).toBe(false);
  } finally {
    f.close();
  }
});

test('compression refuses journal sidecars and symlink destinations rather than losing recovery bytes', () => {
  const f = fixture();
  try {
    const file = f.write(id('2026-10-01'));
    fs.writeFileSync(`${file}-wal`, 'journal data');
    expect(() => compressSnapshot(file)).toThrow('journal sidecar');
    expect(fs.readFileSync(file)).toEqual(f.bytes);
    fs.unlinkSync(`${file}-wal`);
    const elsewhere = f.write('elsewhere.sqlite');
    fs.symlinkSync(elsewhere, `${file}.gz`);
    expect(() => compressSnapshot(file)).toThrow('regular file');
    expect(fs.readFileSync(file)).toEqual(f.bytes);
    expect(fs.readFileSync(elsewhere)).toEqual(f.bytes);
  } finally {
    f.close();
  }
});
