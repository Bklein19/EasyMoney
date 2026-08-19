import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const outdir = path.join(root, 'desktop-dist');

fs.rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [path.join(root, 'scripts', 'sync.ts')],
  outdir,
  target: 'bun',
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error('Failed to bundle the desktop sync worker');
}
