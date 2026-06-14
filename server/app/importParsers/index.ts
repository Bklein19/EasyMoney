import type { AppImportParser } from '../importTypes.ts';
import { meta as chaseCreditCardMeta, parse as parseChaseCreditCard } from './chaseCreditCard.ts';

export const IMPORT_PARSERS: AppImportParser[] = [
  {
    meta: chaseCreditCardMeta,
    parse: parseChaseCreditCard,
  },
];

export function resolveImportParser(file: { fileName: string; headers: string[]; sample: string }) {
  const hits = IMPORT_PARSERS.filter(parser => parser.meta.matches(file));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(`Multiple import parsers match ${file.fileName}: ${hits.map(hit => hit.meta.id).join(', ')}`);
  }
  return null;
}
