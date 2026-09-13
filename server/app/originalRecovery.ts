import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getDb } from '../database';
import { hashContent } from '../hash';
import { syncApplicationDataRoot } from './dataSync/paths';

// Only established EasyMoney stores, never a recursive scan of the user's home.
export async function recoverImportOriginals(roots = [
  join(homedir(), 'src', 'money', 'imports', 'raw'),
  syncApplicationDataRoot(),
], db = getDb()) {
  const missing = db.prepare(`SELECT f.id, f.fileName, f.contentHash FROM importFiles f
    LEFT JOIN importOriginals o ON o.importFileId=f.id WHERE o.importFileId IS NULL`).all();
  const wanted = new Set(missing.map(file => String(file.contentHash)));
  const candidates = new Map<number, { bytes: Uint8Array; hash: string }>();
  const ambiguous = new Set<number>();
  let recovered = 0;
  async function visit(directory: string, depth: number) {
    if (!wanted.size || depth > 5) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(path, depth + 1); continue; }
      if (!entry.isFile() || !/\.(pdf|csv|html?|json|txt)$/i.test(entry.name)) continue;
      const info = await stat(path).catch(() => null);
      if (!info || info.size > 50 * 1024 * 1024) continue;
      const contents = await readFile(path).catch(() => null);
      if (!contents) continue;
      const bytes = new Uint8Array(contents);
      const hash = hashContent(bytes);
      const embeddedHash = entry.name.match(/^([a-f0-9]{64})-/)?.[1];
      if (embeddedHash && embeddedHash !== hash) continue;
      const decodedHash = hashContent(new TextDecoder().decode(bytes));
      if (!wanted.has(hash) && !wanted.has(decodedHash)) continue;
      const plainName = (name: string) => name.replace(/^[a-f0-9]{64}-/, '');
      for (const file of missing.filter(file => file.contentHash === hash ||
        (file.contentHash === decodedHash && plainName(file.fileName) === plainName(entry.name)))) {
        const previous = candidates.get(file.id);
        if (previous && previous.hash !== hash) ambiguous.add(file.id);
        candidates.set(file.id, { bytes, hash });
      }
    }
  }
  for (const root of roots) await visit(root, 0);
  db.transaction(() => {
    for (const file of missing) {
      const candidate = candidates.get(file.id);
      if (!candidate || ambiguous.has(file.id)) continue;
      db.prepare('INSERT OR IGNORE INTO importOriginals (importFileId, contentHash, bytesHash, bytes) VALUES (?, ?, ?, ?)')
        .run(file.id, file.contentHash, candidate.hash, candidate.bytes);
      recovered++;
    }
  })();
  return { recovered, missing: missing.length - recovered };
}
