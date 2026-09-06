import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import Papa from 'papaparse';

import { robinhoodCreditCardCsvParser } from '../../importParsers/easyMoneyCsvProfiles.ts';
import { robinhoodBankingParser } from '../../importParsers/robinhoodBanking.ts';
import { robinhoodBankingStatementParser } from '../../importParsers/robinhoodBankingStatement.ts';
import { robinhoodCreditCardStatementParser } from '../../importParsers/robinhoodCreditCardStatement.ts';
import type { AppImportParseResult, AppImportParser } from '../../importTypes.ts';

const UUID_CSV = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$/i;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export type RobinhoodMobileArtifactKind =
  | 'banking-activity'
  | 'banking-statement'
  | 'credit-activity'
  | 'credit-statement';

export interface RobinhoodMobileArtifact {
  fileName: string;
  sourcePath: string;
  kind: RobinhoodMobileArtifactKind;
  coveredFrom: string;
  coveredTo: string;
  accountLast4: string | null;
  transactionCount: number;
  balanceCount: number;
  modifiedAtMs: number;
}

type RobinhoodCandidateKind = 'csv' | 'banking-statement' | 'credit-statement';

function candidateKind(fileName: string): RobinhoodCandidateKind | null {
  if (UUID_CSV.test(fileName)) return 'csv';
  if (/^bank statement.*\.pdf$/i.test(fileName)) return 'banking-statement';
  if (/^credit statement.*\.pdf$/i.test(fileName)) return 'credit-statement';
  return null;
}

function transactionDates(parsed: AppImportParseResult): string[] {
  return parsed.transactions.flatMap(transaction => transaction ? [transaction.date.slice(0, 10)] : []);
}

function coverage(parsed: AppImportParseResult): { coveredFrom: string; coveredTo: string } {
  const dates = [
    ...transactionDates(parsed),
    ...parsed.balances.map(balance => balance.date.slice(0, 10)),
  ].sort();
  const coveredFrom = parsed.coveredFrom?.slice(0, 10) || dates[0];
  const coveredTo = parsed.coveredTo?.slice(0, 10) || dates.at(-1);
  if (!coveredFrom || !coveredTo) throw new Error('Robinhood export has no dated facts');
  return { coveredFrom, coveredTo };
}

function parsedLast4(parsed: AppImportParseResult): string | null {
  const accountNames = new Set([
    ...parsed.transactions.flatMap(transaction => transaction?.account ? [transaction.account] : []),
    ...parsed.balances.flatMap(balance => balance.account ? [balance.account] : []),
  ]);
  const last4s = new Set([...accountNames].flatMap(name => name.match(/(?:^|\D)(\d{4})$/)?.[1] ?? []));
  return last4s.size === 1 ? [...last4s][0]! : null;
}

async function parseCsvArtifact(
  sourcePath: string,
  fileName: string,
): Promise<{ kind: RobinhoodMobileArtifactKind; parsed: AppImportParseResult }> {
  const text = await readFile(sourcePath, 'utf8');
  const csv = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const fatal = csv.errors.find(error => error.type !== 'FieldMismatch');
  if (fatal) throw new Error(`Could not parse ${fileName}: ${fatal.message}`);
  const headers = csv.meta.fields ?? [];
  const candidates: Array<{ parser: AppImportParser; kind: RobinhoodMobileArtifactKind }> = [
    { parser: robinhoodBankingParser, kind: 'banking-activity' },
    { parser: robinhoodCreditCardCsvParser, kind: 'credit-activity' },
  ];
  const match = candidates.find(candidate => candidate.parser.matches({
    fileName,
    headers,
    sample: text.slice(0, 4096),
  }));
  if (!match) throw new Error(`${fileName} is not a supported Robinhood mobile CSV export`);
  return {
    kind: match.kind,
    parsed: await match.parser.parse({ fileName, headers, rows: csv.data, text }),
  };
}

async function parsePdfArtifact(
  sourcePath: string,
  fileName: string,
  kind: 'banking-statement' | 'credit-statement',
): Promise<AppImportParseResult> {
  const parser = kind === 'banking-statement'
    ? robinhoodBankingStatementParser
    : robinhoodCreditCardStatementParser;
  return parser.parse({ fileName, headers: [], rows: [], text: '', filePath: sourcePath });
}

export function robinhoodMobileExportSourceDir(): string {
  return resolve(process.env.EASYMONEY_ROBINHOOD_EXPORT_DIR?.trim() || join(homedir(), 'Downloads'));
}

export async function discoverRobinhoodMobileExports(
  sourceDir = robinhoodMobileExportSourceDir(),
): Promise<RobinhoodMobileArtifact[]> {
  const root = resolve(sourceDir);
  const entries = await readdir(root, { withFileTypes: true }).catch(error => {
    throw new Error(`Could not read the Robinhood mobile export folder ${root}: ${String(error)}`);
  });
  const artifacts: RobinhoodMobileArtifact[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const hintedKind = candidateKind(entry.name);
    if (!hintedKind) continue;
    const sourcePath = join(root, entry.name);
    const info = await stat(sourcePath);
    if (info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) continue;

    try {
      const result = hintedKind === 'csv'
        ? await parseCsvArtifact(sourcePath, entry.name)
        : { kind: hintedKind, parsed: await parsePdfArtifact(sourcePath, entry.name, hintedKind) };
      const facts = result.parsed.transactions.filter(Boolean).length + result.parsed.balances.length;
      if (facts === 0) continue;
      artifacts.push({
        fileName: entry.name,
        sourcePath,
        kind: result.kind,
        ...coverage(result.parsed),
        accountLast4: parsedLast4(result.parsed),
        transactionCount: result.parsed.transactions.filter(Boolean).length,
        balanceCount: result.parsed.balances.length,
        modifiedAtMs: info.mtimeMs,
      });
    } catch {
      // A filename hint is not enough. Only parser-validated Robinhood exports are staged.
    }
  }

  return artifacts.sort((left, right) =>
    left.coveredTo.localeCompare(right.coveredTo) || left.fileName.localeCompare(right.fileName)
  );
}

export async function stageRobinhoodMobileExports(
  artifacts: readonly RobinhoodMobileArtifact[],
  outputDir: string,
): Promise<void> {
  const root = resolve(outputDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const artifact of artifacts) {
    if (basename(artifact.fileName) !== artifact.fileName) {
      throw new Error('Robinhood export has an unsafe filename');
    }
    await copyFile(artifact.sourcePath, join(root, artifact.fileName));
  }
}
