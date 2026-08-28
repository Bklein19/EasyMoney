import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { DEFAULT_CATEGORIES, DEFAULT_RULES } from '../server/defaultSeedData.ts';

export interface LegacyDataMigrationOptions {
  homeDirectory: string;
  databasePath: string;
  environmentPath: string;
  allowDatabaseMigration?: boolean;
  allowEnvironmentMigration?: boolean;
}

function firstExistingPath(paths: string[]) {
  return paths.find(candidate => fs.existsSync(candidate)) ?? null;
}

interface TableNameRow {
  name: string;
}

interface CategoryRow {
  name: string;
  parentId: number | null;
  type: string | null;
  categoryGroup: string | null;
  description: string | null;
  color: string | null;
  icon: string | null;
}

interface RuleRow {
  pattern: string;
  categoryName: string | null;
  priority: number;
  matchType: string;
}

interface RecoveryMarkerRow {
  marker: string;
  formatVersion: number;
  primarySeedFingerprint: string;
}

const SEED_ONLY_TABLES = new Set(['schemaMigrations', 'categories', 'categorizationRules']);
const RECOVERY_APPLICATION_ID = 0x454d5232;
const RECOVERY_MARKER = 'easymoney-electrobun-v2-recovery';
const RECOVERY_MARKER_TABLE = '__easymoneyDesktopRecovery';
const RECOVERY_FORMAT_VERSION = 1;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function sortedJson(rows: unknown[]) {
  return rows.map(row => JSON.stringify(canonicalValue(row))).sort();
}

function seedStateFingerprint(categories: CategoryRow[], rules: RuleRow[]) {
  return createHash('sha256').update(JSON.stringify({
    categories: sortedJson(categories),
    rules: sortedJson(rules),
  })).digest('hex');
}

function quotedIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function seedStateFingerprintConnection(database: Database) {
  const tableNames = (database.query(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all() as TableNameRow[]).map(row => row.name);

  if (![...SEED_ONLY_TABLES].every(tableName => tableNames.includes(tableName))) {
    return null;
  }

  for (const tableName of tableNames) {
    if (SEED_ONLY_TABLES.has(tableName)) continue;
    const row = database.query(
      `SELECT 1 AS present FROM ${quotedIdentifier(tableName)} LIMIT 1`,
    ).get();
    if (row) return null;
  }

  const categories = database.query(`
    SELECT name, parentId, type, categoryGroup, description, color, icon
    FROM categories
  `).all() as CategoryRow[];
  const rules = database.query(`
    SELECT
      categorizationRules.pattern,
      categories.name AS categoryName,
      categorizationRules.priority,
      categorizationRules.matchType
    FROM categorizationRules
    LEFT JOIN categories ON categories.id = categorizationRules.categoryId
  `).all() as RuleRow[];
  return seedStateFingerprint(categories, rules);
}

const DEFAULT_SEED_STATE_FINGERPRINT = seedStateFingerprint(
  DEFAULT_CATEGORIES.map(category => ({
    ...category,
    parentId: null,
    description: null,
  })),
  DEFAULT_RULES.map(([pattern, categoryName, priority]) => ({
    pattern,
    categoryName,
    priority,
    matchType: 'contains',
  })),
);

function isDefaultOnlyDatabaseConnection(database: Database) {
  return seedStateFingerprintConnection(database) === DEFAULT_SEED_STATE_FINGERPRINT;
}

function isDefaultOnlyDatabase(databasePath: string) {
  const database = new Database(databasePath, { readonly: true });
  try {
    return isDefaultOnlyDatabaseConnection(database);
  } finally {
    database.close();
  }
}

export function databaseContainsDurableUserData(databasePath: string) {
  try {
    return !isDefaultOnlyDatabase(databasePath);
  } catch {
    return false;
  }
}

function defaultSeedFingerprint(databasePath: string) {
  try {
    const database = new Database(databasePath, { readonly: true });
    try {
      const fingerprint = seedStateFingerprintConnection(database);
      return fingerprint === DEFAULT_SEED_STATE_FINGERPRINT ? fingerprint : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

function fsyncDirectory(directoryPath: string) {
  const directory = fs.openSync(directoryPath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function recoveredDatabasePath(destinationPath: string) {
  const extension = path.extname(destinationPath) || '.sqlite';
  const basename = path.basename(destinationPath, path.extname(destinationPath));
  return path.join(path.dirname(destinationPath), `${basename}.legacy-recovered${extension}`);
}

function readRecoveryMarker(databasePath: string) {
  try {
    const database = new Database(databasePath, { readonly: true });
    try {
      const applicationId = database.query('PRAGMA application_id').get() as {
        application_id: number;
      };
      if (applicationId.application_id !== RECOVERY_APPLICATION_ID) return null;
      const check = database.query('PRAGMA quick_check').get() as { quick_check: string };
      if (check.quick_check !== 'ok') return null;
      const marker = database.query(`
        SELECT marker, formatVersion, primarySeedFingerprint
        FROM ${RECOVERY_MARKER_TABLE}
        WHERE id = 1
      `).get() as RecoveryMarkerRow | null;
      if (
        marker?.marker !== RECOVERY_MARKER
        || marker.formatVersion !== RECOVERY_FORMAT_VERSION
        || !/^[a-f0-9]{64}$/.test(marker.primarySeedFingerprint)
      ) return null;
      return marker;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

function primaryMatchesRecoveryMarker(databasePath: string, marker: RecoveryMarkerRow) {
  try {
    const database = new Database(databasePath, { readonly: true });
    try {
      return seedStateFingerprintConnection(database) === marker.primarySeedFingerprint;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

function createSnapshotFile(
  sourcePath: string,
  destinationPath: string,
  primarySeedFingerprint?: string,
) {
  const source = new Database(sourcePath, { readonly: true });
  const temporaryPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${Date.now()}.snapshot.tmp`,
  );
  let completed = false;

  try {
    const snapshot = source.serialize();
    const temporaryFile = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(temporaryFile, snapshot);
      fs.fsyncSync(temporaryFile);
    } finally {
      fs.closeSync(temporaryFile);
    }
    const snapshotDatabase = new Database(temporaryPath);
    try {
      snapshotDatabase.query('PRAGMA journal_mode = DELETE').get();
      if (primarySeedFingerprint) {
        const existingMarkerTable = snapshotDatabase.query(`
          SELECT 1 AS present FROM sqlite_schema
          WHERE type = 'table' AND name = ?
        `).get(RECOVERY_MARKER_TABLE);
        if (existingMarkerTable) throw new Error('Legacy database uses the reserved recovery table');
        snapshotDatabase.exec(`
          PRAGMA application_id = ${RECOVERY_APPLICATION_ID};
          CREATE TABLE ${RECOVERY_MARKER_TABLE} (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            marker TEXT NOT NULL,
            formatVersion INTEGER NOT NULL,
            primarySeedFingerprint TEXT NOT NULL
          );
        `);
        snapshotDatabase.query(`
          INSERT INTO ${RECOVERY_MARKER_TABLE}
            (id, marker, formatVersion, primarySeedFingerprint)
          VALUES (1, ?, ?, ?)
        `).run(RECOVERY_MARKER, RECOVERY_FORMAT_VERSION, primarySeedFingerprint);
      }
      const check = snapshotDatabase.query('PRAGMA quick_check').get() as { quick_check: string };
      if (check.quick_check !== 'ok') throw new Error('Legacy database snapshot failed validation');
    } finally {
      snapshotDatabase.close();
    }
    const snapshotFile = fs.openSync(temporaryPath, 'r');
    try {
      fs.fsyncSync(snapshotFile);
    } finally {
      fs.closeSync(snapshotFile);
    }
    completed = true;
    return temporaryPath;
  } finally {
    source.close();
    if (!completed) fs.rmSync(temporaryPath, { force: true });
  }
}

function publishSnapshotIfAbsent(temporaryPath: string, destinationPath: string) {
  try {
    fs.linkSync(temporaryPath, destinationPath);
    fsyncDirectory(path.dirname(destinationPath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function migrateDatabaseSnapshot(
  sourcePath: string,
  destinationPath: string,
  primarySeedFingerprint?: string,
) {
  let temporaryPath: string | null = null;
  try {
    temporaryPath = createSnapshotFile(sourcePath, destinationPath, primarySeedFingerprint);
    if (publishSnapshotIfAbsent(temporaryPath, destinationPath)) return true;
    if (!primarySeedFingerprint) return databaseContainsDurableUserData(destinationPath);
    const marker = readRecoveryMarker(destinationPath);
    if (marker?.primarySeedFingerprint === primarySeedFingerprint) return true;
    throw new Error(`Refusing to use an unrecognized recovery database at ${destinationPath}`);
  } finally {
    if (temporaryPath) fs.rmSync(temporaryPath, { force: true });
  }
}

export function migrateLegacyData(options: LegacyDataMigrationOptions) {
  const allowDatabaseMigration = options.allowDatabaseMigration ?? true;
  const allowEnvironmentMigration = options.allowEnvironmentMigration ?? true;
  const legacyRoot = path.join(options.homeDirectory, 'src', 'EasyMoney');
  const legacyDatabase = allowDatabaseMigration ? firstExistingPath([
    process.env.EASYMONEY_LEGACY_DB_PATH ?? '',
    path.join(legacyRoot, 'data', 'easymoney.sqlite'),
  ].filter(Boolean)) : null;
  const legacyEnvironment = allowEnvironmentMigration ? firstExistingPath([
    process.env.EASYMONEY_LEGACY_ENV_PATH ?? '',
    path.join(legacyRoot, '.env.local'),
  ].filter(Boolean)) : null;

  let migratedDatabaseFrom: string | null = null;
  let recoveredEmptyDatabase = false;
  let selectedDatabasePath = options.databasePath;
  const destinationExists = fs.existsSync(options.databasePath);
  const primarySeedFingerprint = destinationExists
    ? defaultSeedFingerprint(options.databasePath)
    : null;
  const recoveryPath = recoveredDatabasePath(options.databasePath);
  const recoveryExists = allowDatabaseMigration && fs.existsSync(recoveryPath);
  const recoveryMarker = recoveryExists ? readRecoveryMarker(recoveryPath) : null;

  if (recoveryMarker) {
    if (
      destinationExists
      && !primaryMatchesRecoveryMarker(options.databasePath, recoveryMarker)
    ) {
      throw new Error(
        'Both the primary and recovered EasyMoney databases changed; refusing to choose between them.',
      );
    }
    selectedDatabasePath = recoveryPath;
    recoveredEmptyDatabase = true;
  } else if (recoveryExists && (!destinationExists || primarySeedFingerprint)) {
    throw new Error(`Refusing to use an unrecognized recovery database at ${recoveryPath}`);
  }

  const legacyHasData = Boolean(
    legacyDatabase
    && path.resolve(legacyDatabase) !== path.resolve(options.databasePath)
    && path.resolve(legacyDatabase) !== path.resolve(recoveryPath)
    && databaseContainsDurableUserData(legacyDatabase),
  );
  if (legacyDatabase && legacyHasData && !recoveryMarker) {
    if (!destinationExists && migrateDatabaseSnapshot(legacyDatabase, options.databasePath)) {
      migratedDatabaseFrom = legacyDatabase;
    } else if (
      primarySeedFingerprint
      && migrateDatabaseSnapshot(legacyDatabase, recoveryPath, primarySeedFingerprint)
    ) {
      selectedDatabasePath = recoveryPath;
      migratedDatabaseFrom = legacyDatabase;
      recoveredEmptyDatabase = true;
    }
  }

  if (!fs.existsSync(options.environmentPath) && legacyEnvironment) {
    fs.copyFileSync(legacyEnvironment, options.environmentPath);
    fs.chmodSync(options.environmentPath, 0o600);
  }

  return { databasePath: selectedDatabasePath, migratedDatabaseFrom, recoveredEmptyDatabase };
}
