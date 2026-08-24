import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

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

function displayPath(file: string): string {
  return relative(repositoryRoot, file);
}

describe('data sync architecture', () => {
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
});
