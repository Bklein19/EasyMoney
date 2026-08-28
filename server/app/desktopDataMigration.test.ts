import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { migrateLegacyData } from '../../desktop/dataMigration.ts';
import { DEFAULT_CATEGORIES, DEFAULT_RULES } from '../defaultSeedData.ts';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-desktop-migration-'));

afterAll(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function createDefaultOnlyDatabase(databasePath: string) {
  const database = new Database(databasePath, { create: true });
  database.exec(`
    CREATE TABLE schemaMigrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      parentId INTEGER,
      type TEXT,
      categoryGroup TEXT,
      description TEXT,
      color TEXT,
      icon TEXT
    );
    CREATE TABLE categorizationRules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      categoryId INTEGER NOT NULL,
      pattern TEXT NOT NULL,
      matchType TEXT DEFAULT 'contains',
      priority INTEGER DEFAULT 0
    );
  `);
  database.prepare('INSERT INTO schemaMigrations (id, name) VALUES (?, ?)').run(1, 'seed');

  const categoryIds = new Map<string, number>();
  for (const category of DEFAULT_CATEGORIES) {
    const result = database.prepare(`
      INSERT INTO categories (name, parentId, type, categoryGroup, description, color, icon)
      VALUES (?, NULL, ?, ?, NULL, ?, ?)
    `).run(category.name, category.type, category.categoryGroup, category.color, category.icon);
    categoryIds.set(category.name, Number(result.lastInsertRowid));
  }

  for (const [pattern, categoryName, priority] of DEFAULT_RULES) {
    database.prepare(`
      INSERT INTO categorizationRules (categoryId, pattern, matchType, priority)
      VALUES (?, ?, 'contains', ?)
    `).run(categoryIds.get(categoryName)!, pattern, priority);
  }
  database.close();
}

function createLegacyDatabase(homeDirectory: string, marker: string) {
  const legacyData = path.join(homeDirectory, 'src', 'EasyMoney', 'data');
  fs.mkdirSync(legacyData, { recursive: true });
  const databasePath = path.join(legacyData, 'easymoney.sqlite');
  const database = new Database(databasePath, { create: true });
  database.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  database.prepare('INSERT INTO accounts (name) VALUES (?)').run(marker);
  database.close();
  return databasePath;
}

describe('desktop data migration', () => {
  test('copies a consistent legacy database snapshot and local environment once', () => {
    const homeDirectory = path.join(temporaryRoot, 'initial-copy');
    const legacyRoot = path.join(homeDirectory, 'src', 'EasyMoney');
    const legacyData = path.join(legacyRoot, 'data');
    const destination = path.join(homeDirectory, 'desktop');
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
      homeDirectory,
      databasePath,
      environmentPath,
    });

    const migrated = new Database(databasePath, { readonly: true });
    expect(migrated.prepare('SELECT value FROM example').get()).toEqual({ value: 'preserved' });
    migrated.close();
    expect(fs.readFileSync(environmentPath, 'utf8')).toContain('test-model');
    expect(result.migratedDatabaseFrom).toBe(legacyDatabasePath);
    expect(result.databasePath).toBe(databasePath);

    fs.writeFileSync(databasePath, 'leave-existing-data-alone');
    migrateLegacyData({
      homeDirectory,
      databasePath,
      environmentPath,
    });
    expect(fs.readFileSync(databasePath, 'utf8')).toBe('leave-existing-data-alone');
  });

  test('recovers beside an exact default-only destination without replacing its SQLite files', () => {
    const homeDirectory = path.join(temporaryRoot, 'empty-recovery');
    const legacyDatabasePath = createLegacyDatabase(homeDirectory, 'legacy-account');
    const destination = path.join(homeDirectory, 'desktop');
    fs.mkdirSync(destination, { recursive: true });
    const databasePath = path.join(destination, 'easymoney.sqlite');
    createDefaultOnlyDatabase(databasePath);
    fs.writeFileSync(`${databasePath}-wal`, '');
    fs.writeFileSync(`${databasePath}-shm`, Buffer.alloc(32_768));

    const result = migrateLegacyData({
      homeDirectory,
      databasePath,
      environmentPath: path.join(destination, '.env.local'),
    });

    const recovered = new Database(result.databasePath, { readonly: true });
    expect(recovered.prepare('SELECT name FROM accounts').get()).toEqual({
      name: 'legacy-account',
    });
    recovered.close();
    expect(result).toEqual({
      databasePath: path.join(destination, 'easymoney.legacy-recovered.sqlite'),
      migratedDatabaseFrom: legacyDatabasePath,
      recoveredEmptyDatabase: true,
    });
    const untouched = new Database(databasePath, { readonly: true });
    expect(untouched.prepare('SELECT COUNT(*) AS count FROM accounts').get()).toEqual({ count: 0 });
    untouched.close();
    expect(fs.statSync(`${databasePath}-wal`).size).toBe(0);
    expect(fs.statSync(`${databasePath}-shm`).size).toBe(32_768);
    expect(fs.readdirSync(destination).some(name => name.endsWith('.tmp'))).toBeFalse();

    fs.rmSync(legacyDatabasePath);
    const reused = migrateLegacyData({
      homeDirectory,
      databasePath,
      environmentPath: path.join(destination, '.env.local'),
    });
    expect(reused).toEqual({
      databasePath: result.databasePath,
      migratedDatabaseFrom: null,
      recoveredEmptyDatabase: true,
    });
  });

  test('never overwrites a destination with durable user data', () => {
    const homeDirectory = path.join(temporaryRoot, 'nonempty-preserved');
    createLegacyDatabase(homeDirectory, 'legacy-account');
    const destination = path.join(homeDirectory, 'desktop');
    fs.mkdirSync(destination, { recursive: true });
    const databasePath = path.join(destination, 'easymoney.sqlite');
    createDefaultOnlyDatabase(databasePath);
    const destinationDatabase = new Database(databasePath);
    destinationDatabase.prepare('INSERT INTO accounts (name) VALUES (?)').run('keep-me');
    destinationDatabase.close();

    const result = migrateLegacyData({
      homeDirectory,
      databasePath,
      environmentPath: path.join(destination, '.env.local'),
    });

    const preserved = new Database(databasePath, { readonly: true });
    expect(preserved.prepare('SELECT name FROM accounts').get()).toEqual({ name: 'keep-me' });
    preserved.close();
    expect(result).toEqual({
      databasePath,
      migratedDatabaseFrom: null,
      recoveredEmptyDatabase: false,
    });
  });

  test('treats customized seed metadata as durable user data', () => {
    const homeDirectory = path.join(temporaryRoot, 'custom-seed-preserved');
    createLegacyDatabase(homeDirectory, 'legacy-account');
    const destination = path.join(homeDirectory, 'desktop');
    fs.mkdirSync(destination, { recursive: true });
    const databasePath = path.join(destination, 'easymoney.sqlite');
    createDefaultOnlyDatabase(databasePath);
    const destinationDatabase = new Database(databasePath);
    destinationDatabase.prepare(`
      UPDATE categories SET color = '#000000' WHERE name = 'Groceries'
    `).run();
    destinationDatabase.close();

    const result = migrateLegacyData({
      homeDirectory,
      databasePath,
      environmentPath: path.join(destination, '.env.local'),
    });

    const preserved = new Database(databasePath, { readonly: true });
    expect(preserved.prepare(`
      SELECT color FROM categories WHERE name = 'Groceries'
    `).get()).toEqual({ color: '#000000' });
    preserved.close();
    expect(result).toEqual({
      databasePath,
      migratedDatabaseFrom: null,
      recoveredEmptyDatabase: false,
    });
  });

  test('does not replace a destination missing part of the exact default seed', () => {
    const homeDirectory = path.join(temporaryRoot, 'partial-seed-preserved');
    createLegacyDatabase(homeDirectory, 'legacy-account');
    const destination = path.join(homeDirectory, 'desktop');
    fs.mkdirSync(destination, { recursive: true });
    const databasePath = path.join(destination, 'easymoney.sqlite');
    createDefaultOnlyDatabase(databasePath);
    const destinationDatabase = new Database(databasePath);
    destinationDatabase.exec('DELETE FROM categorizationRules; DELETE FROM categories;');
    destinationDatabase.close();

    const result = migrateLegacyData({
      homeDirectory,
      databasePath,
      environmentPath: path.join(destination, '.env.local'),
    });

    const preserved = new Database(databasePath, { readonly: true });
    expect(preserved.prepare('SELECT COUNT(*) AS count FROM accounts').get()).toEqual({ count: 0 });
    preserved.close();
    expect(result).toEqual({
      databasePath,
      migratedDatabaseFrom: null,
      recoveredEmptyDatabase: false,
    });
  });

  test('does not hide orphaned categorization rules while classifying a destination', () => {
    const homeDirectory = path.join(temporaryRoot, 'orphan-rule-preserved');
    createLegacyDatabase(homeDirectory, 'legacy-account');
    const destination = path.join(homeDirectory, 'desktop');
    fs.mkdirSync(destination, { recursive: true });
    const databasePath = path.join(destination, 'easymoney.sqlite');
    createDefaultOnlyDatabase(databasePath);
    const destinationDatabase = new Database(databasePath);
    destinationDatabase.prepare(`
      INSERT INTO categorizationRules (categoryId, pattern, matchType, priority)
      VALUES (999999, 'custom-orphan', 'contains', 1)
    `).run();
    destinationDatabase.close();

    const result = migrateLegacyData({
      homeDirectory,
      databasePath,
      environmentPath: path.join(destination, '.env.local'),
    });

    const preserved = new Database(databasePath, { readonly: true });
    expect(preserved.prepare(`
      SELECT COUNT(*) AS count FROM categorizationRules WHERE pattern = 'custom-orphan'
    `).get()).toEqual({ count: 1 });
    preserved.close();
    expect(result).toEqual({
      databasePath,
      migratedDatabaseFrom: null,
      recoveredEmptyDatabase: false,
    });
  });

  test('recovers without touching another connection or its real destination WAL', () => {
    const homeDirectory = path.join(temporaryRoot, 'live-wal-preserved');
    createLegacyDatabase(homeDirectory, 'legacy-account');
    const destination = path.join(homeDirectory, 'desktop');
    fs.mkdirSync(destination, { recursive: true });
    const databasePath = path.join(destination, 'easymoney.sqlite');
    createDefaultOnlyDatabase(databasePath);
    const liveDatabase = new Database(databasePath);

    try {
      liveDatabase.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
      liveDatabase.exec(`
        BEGIN;
        UPDATE categories SET color = '#temporary' WHERE name = 'Groceries';
        UPDATE categories SET color = '#22c55e' WHERE name = 'Groceries';
        COMMIT;
      `);
      expect(fs.statSync(`${databasePath}-wal`).size).toBeGreaterThan(0);

      const result = migrateLegacyData({
        homeDirectory,
        databasePath,
        environmentPath: path.join(destination, '.env.local'),
      });

      expect(result).toEqual({
        databasePath: path.join(destination, 'easymoney.legacy-recovered.sqlite'),
        migratedDatabaseFrom: path.join(
          homeDirectory,
          'src',
          'EasyMoney',
          'data',
          'easymoney.sqlite',
        ),
        recoveredEmptyDatabase: true,
      });
      expect(liveDatabase.prepare('SELECT COUNT(*) AS count FROM accounts').get()).toEqual({
        count: 0,
      });
      expect(liveDatabase.prepare(`
        SELECT color FROM categories WHERE name = 'Groceries'
      `).get()).toEqual({ color: '#22c55e' });
      expect(fs.statSync(`${databasePath}-wal`).size).toBeGreaterThan(0);
      const recovered = new Database(result.databasePath, { readonly: true });
      expect(recovered.prepare('SELECT name FROM accounts').get()).toEqual({
        name: 'legacy-account',
      });
      recovered.close();
    } finally {
      liveDatabase.close();
    }
  });

  test('preserves the original destination when sibling snapshot publication fails', () => {
    const homeDirectory = path.join(temporaryRoot, 'publish-failure-rollback');
    createLegacyDatabase(homeDirectory, 'legacy-account');
    const destination = path.join(homeDirectory, 'desktop');
    fs.mkdirSync(destination, { recursive: true });
    const databasePath = path.join(destination, 'easymoney.sqlite');
    createDefaultOnlyDatabase(databasePath);

    const originalLink = fs.linkSync;
    let failureInjected = false;
    const linkSpy = spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      if (
        !failureInjected
        && String(source).endsWith('.snapshot.tmp')
        && String(target).endsWith('easymoney.legacy-recovered.sqlite')
      ) {
        failureInjected = true;
        throw Object.assign(new Error('injected publish failure'), { code: 'EIO' });
      }
      return originalLink(source, target);
    });

    try {
      expect(() => migrateLegacyData({
          homeDirectory,
          databasePath,
          environmentPath: path.join(destination, '.env.local'),
        })).toThrow('injected publish failure');
    } finally {
      linkSpy.mockRestore();
    }

    expect(failureInjected).toBeTrue();
    const restored = new Database(databasePath, { readonly: true });
    expect(restored.prepare('SELECT COUNT(*) AS count FROM accounts').get()).toEqual({ count: 0 });
    expect(restored.prepare('SELECT COUNT(*) AS count FROM categories').get()).toEqual({
      count: DEFAULT_CATEGORIES.length,
    });
    restored.close();
    expect(fs.existsSync(path.join(destination, 'easymoney.legacy-recovered.sqlite'))).toBeFalse();
    expect(fs.readdirSync(destination).some(name => name.endsWith('.tmp'))).toBeFalse();
  });

  test('rejects every unmarked recovery-path collision without selecting or overwriting it', () => {
    const collisions: Array<[string, (databasePath: string) => void]> = [
      ['zero-byte', databasePath => fs.writeFileSync(databasePath, '')],
      ['empty-valid', databasePath => {
        const database = new Database(databasePath, { create: true });
        database.exec('VACUUM');
        database.close();
      }],
      ['unrelated', databasePath => {
        const database = new Database(databasePath, { create: true });
        database.exec('CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES (\'keep\');');
        database.close();
      }],
    ];

    for (const [name, createCollision] of collisions) {
      const homeDirectory = path.join(temporaryRoot, `recovery-collision-${name}`);
      createLegacyDatabase(homeDirectory, 'legacy-account');
      const destination = path.join(homeDirectory, 'desktop');
      fs.mkdirSync(destination, { recursive: true });
      const databasePath = path.join(destination, 'easymoney.sqlite');
      const recoveryPath = path.join(destination, 'easymoney.legacy-recovered.sqlite');
      createDefaultOnlyDatabase(databasePath);
      createCollision(recoveryPath);
      const originalCollision = fs.readFileSync(recoveryPath);

      expect(() => migrateLegacyData({
        homeDirectory,
        databasePath,
        environmentPath: path.join(destination, '.env.local'),
      })).toThrow('unrecognized recovery database');
      expect(fs.readFileSync(recoveryPath)).toEqual(originalCollision);
      const primary = new Database(databasePath, { readonly: true });
      expect(primary.prepare('SELECT COUNT(*) AS count FROM accounts').get()).toEqual({ count: 0 });
      primary.close();
    }
  });

  test('reports a conflict instead of switching paths after the primary changes', () => {
    const homeDirectory = path.join(temporaryRoot, 'recovery-conflict');
    createLegacyDatabase(homeDirectory, 'legacy-account');
    const destination = path.join(homeDirectory, 'desktop');
    fs.mkdirSync(destination, { recursive: true });
    const databasePath = path.join(destination, 'easymoney.sqlite');
    createDefaultOnlyDatabase(databasePath);

    const recovered = migrateLegacyData({
      homeDirectory,
      databasePath,
      environmentPath: path.join(destination, '.env.local'),
    });
    expect(recovered.recoveredEmptyDatabase).toBeTrue();

    const changedPrimary = new Database(databasePath);
    changedPrimary.prepare('INSERT INTO accounts (name) VALUES (?)').run('changed-primary');
    changedPrimary.close();

    expect(() => migrateLegacyData({
      homeDirectory,
      databasePath,
      environmentPath: path.join(destination, '.env.local'),
    })).toThrow('refusing to choose between them');
    const canonicalRecovery = new Database(recovered.databasePath, { readonly: true });
    expect(canonicalRecovery.prepare('SELECT name FROM accounts').get()).toEqual({
      name: 'legacy-account',
    });
    canonicalRecovery.close();
  });

  test('migrates database and environment independently around explicit overrides', () => {
    const databaseOverrideHome = path.join(temporaryRoot, 'database-override');
    const databaseOverrideLegacy = path.join(databaseOverrideHome, 'src', 'EasyMoney');
    createLegacyDatabase(databaseOverrideHome, 'legacy-account');
    fs.writeFileSync(path.join(databaseOverrideLegacy, '.env.local'), 'FROM_LEGACY="yes"\n');
    const databaseOverrideDestination = path.join(databaseOverrideHome, 'desktop');
    fs.mkdirSync(databaseOverrideDestination, { recursive: true });
    const protectedDatabase = path.join(databaseOverrideDestination, 'explicit.sqlite');
    fs.writeFileSync(protectedDatabase, 'explicit-database');
    const migratedEnvironment = path.join(databaseOverrideDestination, '.env.local');

    const databaseOverrideResult = migrateLegacyData({
      homeDirectory: databaseOverrideHome,
      databasePath: protectedDatabase,
      environmentPath: migratedEnvironment,
      allowDatabaseMigration: false,
      allowEnvironmentMigration: true,
    });

    expect(fs.readFileSync(protectedDatabase, 'utf8')).toBe('explicit-database');
    expect(fs.readFileSync(migratedEnvironment, 'utf8')).toContain('FROM_LEGACY');
    expect(databaseOverrideResult).toEqual({
      databasePath: protectedDatabase,
      migratedDatabaseFrom: null,
      recoveredEmptyDatabase: false,
    });

    const environmentOverrideHome = path.join(temporaryRoot, 'environment-override');
    createLegacyDatabase(environmentOverrideHome, 'legacy-account');
    const environmentOverrideDestination = path.join(environmentOverrideHome, 'desktop');
    fs.mkdirSync(environmentOverrideDestination, { recursive: true });
    const migratedDatabase = path.join(environmentOverrideDestination, 'easymoney.sqlite');
    const protectedEnvironment = path.join(environmentOverrideDestination, 'explicit.env');
    fs.writeFileSync(protectedEnvironment, 'KEEP_ME="yes"\n');

    const environmentOverrideResult = migrateLegacyData({
      homeDirectory: environmentOverrideHome,
      databasePath: migratedDatabase,
      environmentPath: protectedEnvironment,
      allowDatabaseMigration: true,
      allowEnvironmentMigration: false,
    });

    const migrated = new Database(environmentOverrideResult.databasePath, { readonly: true });
    expect(migrated.prepare('SELECT name FROM accounts').get()).toEqual({
      name: 'legacy-account',
    });
    migrated.close();
    expect(fs.readFileSync(protectedEnvironment, 'utf8')).toContain('KEEP_ME');
    expect(environmentOverrideResult.migratedDatabaseFrom).not.toBeNull();
  });
});
