import type { AppImportParser } from '../importTypes.ts';
import { bofaActivityParser } from './bofaActivity.ts';
import { bofaStatementParser } from './bofaStatement.ts';
import { chaseCreditCardParser } from './chaseCreditCard.ts';
import { legacyCsvProfileParsers } from './legacyCsvProfiles.ts';
import { vanguardActivityParser } from './vanguardActivity.ts';
import { vanguardStatementParser } from './vanguardStatement.ts';

export const IMPORT_PARSERS: AppImportParser[] = [
  chaseCreditCardParser,
  bofaActivityParser,
  bofaStatementParser,
  vanguardActivityParser,
  vanguardStatementParser,
  ...legacyCsvProfileParsers,
];

export function resolveImportParser(file: { fileName: string; headers: string[]; sample: string }) {
  const hits = IMPORT_PARSERS.filter(parser => parser.matches(file));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(`Multiple import parsers match ${file.fileName}: ${hits.map(hit => hit.id).join(', ')}`);
  }
  return null;
}
