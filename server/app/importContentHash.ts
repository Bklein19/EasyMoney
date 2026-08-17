import { hashContent } from '../hash.ts';

export function hashImportContent(text: string, fileBytes?: Uint8Array) {
  return hashContent(fileBytes ?? text);
}
