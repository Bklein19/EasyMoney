import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

export interface LegacyDataMigrationOptions {
  homeDirectory: string;
  databasePath: string;
  environmentPath: string;
}

function firstExistingPath(paths: string[]) {
  return paths.find(candidate => fs.existsSync(candidate)) ?? null;
}

export function migrateLegacyData(options: LegacyDataMigrationOptions) {
  const legacyRoot = path.join(options.homeDirectory, 'src', 'EasyMoney');
  const legacyDatabase = firstExistingPath([
    process.env.EASYMONEY_LEGACY_DB_PATH ?? '',
    path.join(legacyRoot, 'data', 'easymoney.sqlite'),
  ].filter(Boolean));
  const legacyEnvironment = firstExistingPath([
    process.env.EASYMONEY_LEGACY_ENV_PATH ?? '',
    path.join(legacyRoot, '.env.local'),
  ].filter(Boolean));

  let migratedDatabaseFrom: string | null = null;
  if (!fs.existsSync(options.databasePath) && legacyDatabase) {
    const source = new Database(legacyDatabase, { readonly: true });
    try {
      fs.writeFileSync(options.databasePath, source.serialize(), { mode: 0o600 });
      migratedDatabaseFrom = legacyDatabase;
    } finally {
      source.close();
    }
  }

  if (!fs.existsSync(options.environmentPath) && legacyEnvironment) {
    fs.copyFileSync(legacyEnvironment, options.environmentPath);
    fs.chmodSync(options.environmentPath, 0o600);
  }

  return { migratedDatabaseFrom };
}
