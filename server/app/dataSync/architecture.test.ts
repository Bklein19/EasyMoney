import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { syncConnectors } from './registry.ts';

const dataSyncDirectory = resolve(import.meta.dir);
const repositoryRoot = resolve(dataSyncDirectory, '../../..');

function sharedDataSyncFiles(): string[] {
  return [...new Bun.Glob('**/*.ts').scanSync({
    cwd: dataSyncDirectory,
    absolute: true,
  })].filter(file =>
    !file.includes('/institutions/') &&
    !file.endsWith('.test.ts') &&
    !file.endsWith('/registry.ts')
  );
}

function institutionProductionFiles(): string[] {
  return [...new Bun.Glob('institutions/*.ts').scanSync({
    cwd: dataSyncDirectory,
    absolute: true,
  })].filter(file => !file.endsWith('.test.ts'));
}

function displayPath(file: string): string {
  return relative(repositoryRoot, file);
}

function relativeTypeScriptImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g)]
    .map(match => resolve(dirname(file), match[1]!))
    .map(candidate => existsSync(candidate) ? candidate : `${candidate}.ts`)
    .filter(candidate => existsSync(candidate));
}

function dependencyClosure(entrypoint: string): string[] {
  const pending = [entrypoint];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    pending.push(...relativeTypeScriptImports(file));
  }
  return [...visited];
}

describe('data sync architecture', () => {
  test('keeps AutomationControlled suppression in the shared browser launcher', () => {
    const violations = institutionProductionFiles()
      .filter(file => readFileSync(file, 'utf8').includes('AutomationControlled'));

    expect(violations.map(displayPath)).toEqual([]);
  });

  test('keeps authenticated HTTP replay in the shared browser-native transport', () => {
    const forbidden = [
      /page\.context\(\)\.request/,
      /context\(\)\.request/,
      /\.request\.fetch\s*\(/,
      /\bAPIRequestContext\b/,
      /\bAPIResponse\b/,
      /\bfetch\s*\(/,
    ];
    const violations = institutionProductionFiles().flatMap(file => {
      const source = readFileSync(file, 'utf8');
      const matches = forbidden.filter(pattern => pattern.test(source)).map(pattern => pattern.source);
      return matches.length === 0 ? [] : [{ file: displayPath(file), matches }];
    });

    expect(violations).toEqual([]);
  });

  test('keeps concrete connector imports inside the registry composition root', () => {
    const violations = sharedDataSyncFiles().filter(file =>
      /(?:from|import\()\s*['"][^'"]*\/institutions\//.test(readFileSync(file, 'utf8'))
    );

    expect(violations.map(displayPath)).toEqual([]);
  });

  test('keeps institution identifiers out of shared application modules', () => {
    const files = [
      ...sharedDataSyncFiles(),
      resolve(repositoryRoot, 'server/app/router.ts'),
      resolve(repositoryRoot, 'server/app/dataFreshness.ts'),
      resolve(repositoryRoot, 'scripts/sync.ts'),
    ];
    const terms = syncConnectors.flatMap(connector => [connector.id, connector.label]);
    const violations = files.flatMap(file => {
      const source = readFileSync(file, 'utf8').toLowerCase();
      const matches = terms.filter(term => source.includes(term.toLowerCase()));
      return matches.length === 0 ? [] : [{ file: displayPath(file), matches }];
    });

    expect(violations).toEqual([]);
  });

  test('keeps the sync worker dependency graph database-free', () => {
    const entrypoint = resolve(repositoryRoot, 'scripts/sync.ts');
    const dependencies = dependencyClosure(entrypoint).map(displayPath);

    expect(dependencies).not.toContain('server/database.ts');
    expect(dependencies).not.toContain('server/app/dataSync/coverage.ts');
    expect(dependencies).not.toContain('server/app/dataSync/review.ts');
    expect(readFileSync(entrypoint, 'utf8')).not.toMatch(/initDatabase|closeDatabase|getDb/);
  });

  test('keeps the bundled sync worker free of application database code', async () => {
    const result = await Bun.build({
      entrypoints: [resolve(repositoryRoot, 'scripts/sync.ts')],
      target: 'bun',
    });
    expect(result.success).toBe(true);
    const bundle = await result.outputs[0]!.text();

    expect(bundle).not.toContain('server/database.ts');
    expect(bundle).not.toContain('bun:sqlite');
    expect(bundle).not.toMatch(/function getDb\b|initDatabase\s*\(/);
  });
});
