import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { migrateLegacyData } from '../../desktop/dataMigration.ts';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-desktop-migration-'));

afterAll(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('desktop data migration', () => {
  test('copies a consistent legacy database snapshot and local environment once', () => {
    const legacyRoot = path.join(temporaryRoot, 'src', 'EasyMoney');
    const legacyData = path.join(legacyRoot, 'data');
    const destination = path.join(temporaryRoot, 'desktop');
    fs.mkdirSync(legacyData, { recursive: true });
    fs.mkdirSync(destination, { recursive: true });

    const legacyDatabasePath = path.join(legacyData, 'easymoney.sqlite');
    const source = new Database(legacyDatabasePath, { create: true });
    source.exec('CREATE TABLE example (value TEXT NOT NULL)');
    source.prepare('INSERT INTO example (value) VALUES (?)').run('preserved');
    source.close();
    fs.writeFileSync(path.join(legacyRoot, '.env.local'), 'OPENAI_CATEGORIZATION_MODEL="test-model"\n');

    const databasePath = path.join(destination, 'easymoney.sqlite');
    const environmentPath = path.join(destination, '.env.local');
    const result = migrateLegacyData({
      homeDirectory: temporaryRoot,
      databasePath,
      environmentPath,
    });

    const migrated = new Database(databasePath, { readonly: true });
    expect(migrated.prepare('SELECT value FROM example').get()).toEqual({ value: 'preserved' });
    migrated.close();
    expect(fs.readFileSync(environmentPath, 'utf8')).toContain('test-model');
    expect(result.migratedDatabaseFrom).toBe(legacyDatabasePath);

    fs.writeFileSync(databasePath, 'leave-existing-data-alone');
    migrateLegacyData({
      homeDirectory: temporaryRoot,
      databasePath,
      environmentPath,
    });
    expect(fs.readFileSync(databasePath, 'utf8')).toBe('leave-existing-data-alone');
  });
});
