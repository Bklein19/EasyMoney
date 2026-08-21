import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IconIcns } from '@shockpkg/icon-encoder';

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

  if (process.platform === 'darwin') {
    const iconDirectory = path.join(root, 'assets', 'icon.iconset');
    const icon = new IconIcns();
    icon.toc = true;

    const entries: Array<[string, string]> = [
      ['icon_32x32@2x.png', 'ic12'],
      ['icon_128x128.png', 'ic07'],
      ['icon_128x128@2x.png', 'ic13'],
      ['icon_256x256.png', 'ic08'],
      ['icon_16x16.png', 'ic04'],
      ['icon_256x256@2x.png', 'ic14'],
      ['icon_512x512.png', 'ic09'],
      ['icon_32x32.png', 'ic05'],
      ['icon_512x512@2x.png', 'ic10'],
      ['icon_16x16@2x.png', 'ic11'],
    ];

    for (const [fileName, type] of entries) {
      await icon.addFromPng(fs.readFileSync(path.join(iconDirectory, fileName)), [type], true);
    }
    writeIfChanged(path.join(outdir, 'AppIcon.icns'), icon.encode());
  }
} finally {
  fs.rmSync(temporaryOutdir, { recursive: true, force: true });
}
