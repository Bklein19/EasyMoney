import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const outdir = path.join(root, 'desktop-dist');
const temporaryOutdir = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-desktop-sync-'));

function writeIfChanged(destination: string, contents: Uint8Array) {
  if (fs.existsSync(destination)) {
    const existing = fs.readFileSync(destination);
    if (existing.equals(contents)) return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

try {
  const result = await Bun.build({
    entrypoints: [path.join(root, 'scripts', 'sync.ts')],
    outdir: temporaryOutdir,
    target: 'bun',
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('Failed to bundle the desktop sync worker');
  }

  writeIfChanged(
    path.join(outdir, 'sync.js'),
    fs.readFileSync(path.join(temporaryOutdir, 'sync.js')),
  );

} finally {
  fs.rmSync(temporaryOutdir, { recursive: true, force: true });
}
