import { Database } from 'bun:sqlite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { IMPORT_PARSERS } from '../server/app/importParsers';
import { StatementValidationError } from '../server/app/importParsers/statementValidation';

const databasePath = process.argv[2];
if (!databasePath) throw new Error('Usage: bun scripts/validate-retained-statements.ts DATABASE');
const db = new Database(databasePath, { readonly: true });
db.exec('PRAGMA query_only=ON; BEGIN');
const directory = await mkdtemp(join(tmpdir(), 'easymoney-statement-check-'));
const counts: Record<string, Record<string, number>> = {};
try {
  const rows = db.query(`SELECT sf.parserName,sf.fileName,io.bytes,io.bytesHash FROM sourceFiles sf
    LEFT JOIN importOriginals io ON io.importFileId=sf.importFileId
    WHERE sf.status='committed' AND sf.sourceType='statement' ORDER BY sf.id`).all() as Array<{ parserName: string; fileName: string; bytes: Uint8Array | null; bytesHash: string | null }>;
  for (const row of rows) {
    const count = counts[row.parserName] ??= {};
    let status = 'unavailable';
    const path = join(directory, basename(row.fileName).replace(/^[a-f0-9]{64}-/, ''));
    try {
      if (!row.bytes || createHash('sha256').update(row.bytes).digest('hex') !== row.bytesHash) {
        status = 'original-missing-or-corrupt';
      } else {
        const parser = IMPORT_PARSERS.find(parser => parser.id === row.parserName);
        if (!parser) status = 'parser-unavailable';
        else {
          await writeFile(path, row.bytes, { mode: 0o600 });
          const parsed = await parser.parse({ filePath: path, fileName: basename(path), fileBytes: row.bytes, text: new TextDecoder().decode(row.bytes), headers: [], rows: [] });
          const evidence = parsed.balances.map(balance => balance.raw?.statementValidation as { status?: string; checks?: string[]; transactionCompleteness?: string } | undefined);
          if (evidence.length && evidence.every(item => item?.status === 'passed')) {
            status = evidence.every(item => item?.checks?.includes('parsed-credits') && item.checks.includes('parsed-debits')) ? 'transaction-totals-passed'
              : evidence.every(item => item?.checks?.includes('investment-roll-forward')) ? 'balance-summary-passed'
              : evidence.every(item => item?.checks?.includes('printed-section-totals')) ? 'section-totals-passed' : 'recognized-rows-passed';
          }
        }
      }
    } catch (error) { status = error instanceof StatementValidationError ? `failed:${error.code}` : 'failed:parser'; }
    finally { await rm(path, { force: true }); }
    count[status] = (count[status] ?? 0) + 1;
  }
  // Only parser IDs and aggregate counts are emitted; no financial contents.
  console.log(JSON.stringify(counts, null, 2));
  if (Object.values(counts).some(group => Object.keys(group).some(key => key.startsWith('failed:') || key === 'original-missing-or-corrupt'))) process.exitCode = 1;
} finally { db.exec('ROLLBACK'); db.close(); await rm(directory, { recursive: true, force: true }); }
