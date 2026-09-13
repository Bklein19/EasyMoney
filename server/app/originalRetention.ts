import { getDb } from '../database';
import { hashContent } from '../hash';

export function assertRetainedOriginal(importFileId: number, db = getDb()) {
  const metadata = db.prepare('SELECT contentHash FROM importFiles WHERE id=?').get(importFileId);
  if (!metadata) throw new Error('Import file was not found.');
  const original = db.prepare('SELECT bytes, bytesHash FROM importOriginals WHERE importFileId=?').get(importFileId);
  if (original) {
    const actual = hashContent(original.bytes);
    if (actual !== original.bytesHash || (actual !== metadata.contentHash && hashContent(new TextDecoder().decode(original.bytes)) !== metadata.contentHash)) {
      throw new Error('Retained original failed its integrity check. Import was not committed.');
    }
    return;
  }
  const sources = db.prepare('SELECT id,contentHash FROM sourceFiles WHERE importFileId=?').all(importFileId);
  if (!sources.length || sources.some(source => {
    const replacement = db.prepare(`SELECT bytes,bytesHash FROM importReplacementVersions
      WHERE sourceFileId=? AND importFileId=? AND priorContentHash=? ORDER BY id DESC LIMIT 1`)
      .get(source.id,importFileId,source.contentHash);
    return !replacement || hashContent(replacement.bytes) !== replacement.bytesHash;
  })) throw new Error('Original file is not retained. Restore it before committing this import.');
}
