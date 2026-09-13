import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dir, '..');
const registry = resolve(root, 'server/app/importParsers/index.ts');
const dependencies = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).dependencies;
const scanner = new Bun.Transpiler({ loader: 'ts' });

// Hash each parser's local dependency graph, including shared adapters/helpers.
// The generated manifest is bundled, so installed apps need no source checkout.
export async function generateParserVersions() {
  const versions: Record<string, string> = {};
  for (const entry of scanner.scanImports(await readFile(registry, 'utf8'))) {
    if (!entry.path.startsWith('./')) continue;
    const file = resolve(dirname(registry), entry.path);
    const seen = new Map<string, string>();
    async function visit(filePath: string) {
      if (seen.has(filePath)) return;
      const content = await readFile(filePath, 'utf8');
      seen.set(filePath, content);
      for (const dependency of scanner.scanImports(content)) {
        if (!dependency.path.startsWith('.')) {
          const name = dependency.path.startsWith('@') ? dependency.path.split('/').slice(0, 2).join('/') : dependency.path.split('/')[0]!;
          const installed = await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8').catch(() => null);
          seen.set(`package:${name}`, installed ? JSON.parse(installed).version : dependencies[name] || 'builtin');
          continue;
        }
        let target = resolve(dirname(filePath), dependency.path);
        if (!/\.(?:ts|json)$/.test(target)) target += '.ts';
        await visit(target);
      }
    }
    await visit(file);
    const hash = createHash('sha256').update(JSON.stringify([...seen].map(([name, content]) => [name.startsWith('package:') ? name : relative(root, name), content]).sort())).digest('hex');
    const module = await import(file);
    for (const value of Object.values(module).flat()) {
      if (value && typeof value === 'object' && 'id' in value && 'parse' in value) versions[String(value.id)] = hash;
    }
  }
  return Object.fromEntries(Object.entries(versions).sort());
}

if (import.meta.main) {
  await writeFile(resolve(root, 'server/app/importParsers/versions.json'), JSON.stringify(await generateParserVersions(), null, 2) + '\n');
}
