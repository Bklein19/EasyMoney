import type { AppImportParser } from '../importTypes.ts';
import { bofaActivityParser } from './bofaActivity.ts';
import { bofaCreditCardActivityParser } from './bofaCreditCardActivity.ts';
import { bofaStatementParser } from './bofaStatement.ts';
import { chaseCreditCardParser } from './chaseCreditCard.ts';
import { easyMoneyCsvProfileParsers } from './easyMoneyCsvProfiles.ts';
import { fidelity401kParser } from './fidelity401k.ts';
import { fidelityActivityParser } from './fidelityActivity.ts';
import { fidelityActivityApiParser } from './fidelityActivityApi.ts';
import { fidelityInvestmentReportParser } from './fidelityInvestmentReport.ts';
import { fidelityNetBenefitsStatementParser } from './fidelityNetBenefitsStatement.ts';
import { fidelityPortfolioStatementParser } from './fidelityPortfolioStatement.ts';
import { marcusStatementParser } from './marcusStatement.ts';
import { merrillActivityParser } from './merrillActivity.ts';
import { merrillStatementParser } from './merrillStatement.ts';
import { morganStanleyActivityParser } from './morganStanleyActivity.ts';
import { morganStanleyStatementParser } from './morganStanleyStatement.ts';
import { robinhoodBankingParser } from './robinhoodBanking.ts';
import { robinhoodBankingStatementParser } from './robinhoodBankingStatement.ts';
import { robinhoodCreditCardStatementParser } from './robinhoodCreditCardStatement.ts';
import { robinhoodStatementParser } from './robinhoodStatement.ts';
import { sequoiaFundActivityParser } from './sequoiaFundActivity.ts';
import { sequoiaFundStatementParser } from './sequoiaFundStatement.ts';
import { tiaaActivityParser } from './tiaaActivity.ts';
import { tiaaStatementParser } from './tiaaStatement.ts';
import { vanguardActivityParser } from './vanguardActivity.ts';
import { vanguardActivityCsvParser } from './vanguardActivityCsv.ts';
import { vanguardStatementParser } from './vanguardStatement.ts';
import { wellsFargoActivityParser } from './wellsFargoActivity.ts';
import { wellsFargoGenericActivityParser } from './wellsFargoGenericActivity.ts';
import { wellsFargoStatementParser } from './wellsFargoStatement.ts';

export const IMPORT_PARSERS: AppImportParser[] = [
  chaseCreditCardParser,
  bofaCreditCardActivityParser,
  bofaActivityParser,
  fidelityActivityApiParser,
  fidelityActivityParser,
  wellsFargoActivityParser,
  wellsFargoGenericActivityParser,
  merrillActivityParser,
  tiaaActivityParser,
  robinhoodBankingParser,
  robinhoodBankingStatementParser,
  robinhoodCreditCardStatementParser,
  vanguardActivityParser,
  vanguardActivityCsvParser,
  morganStanleyActivityParser,
  sequoiaFundActivityParser,
  bofaStatementParser,
  wellsFargoStatementParser,
  morganStanleyStatementParser,
  fidelity401kParser,
  fidelityNetBenefitsStatementParser,
  fidelityPortfolioStatementParser,
  fidelityInvestmentReportParser,
  robinhoodStatementParser,
  marcusStatementParser,
  merrillStatementParser,
  sequoiaFundStatementParser,
  tiaaStatementParser,
  vanguardStatementParser,
  ...easyMoneyCsvProfileParsers,
];

export function importParserDisplayName(parserId: string | null | undefined): string | null {
  if (!parserId) return null;
  return IMPORT_PARSERS.find(parser => parser.id === parserId)?.name ?? null;
}

function normalizedInstitution(value: string | null): string {
  return String(value ?? '').trim().toLowerCase();
}

function parserSupportsAccountType(parser: AppImportParser, accountType: string): boolean {
  const normalizedType = accountType.toLowerCase();
  const creditAccount = /credit|card/.test(normalizedType);
  const creditParser = /credit-card|\bcard\b/.test(parser.id);
  if (creditAccount) return creditParser || parser.sourceType === 'statement';
  return !creditParser;
}

function parserDownloadLabel(parser: AppImportParser): string {
  const extension = parser.id.match(/-(csv|pdf|html)$/)?.[1]?.toUpperCase();
  const source = parser.sourceType === 'statement'
    ? /investment-report/.test(parser.id) ? 'Investment report' : 'Statement'
    : /credit-card/.test(parser.id) ? 'Credit-card activity' : 'Activity';
  return extension ? `${source} ${extension}` : source;
}

export function importDownloadSuggestions(institution: string | null, accountType: string): string[] {
  const accountInstitution = normalizedInstitution(institution);
  const suggestions = new Set<string>();
  const normalizedType = accountType.toLowerCase();
  if (['checking', 'savings', 'cash'].includes(normalizedType)) suggestions.add('Activity CSV');
  if (['investment', 'retirement', 'brokerage'].includes(normalizedType)) {
    suggestions.add('Activity export');
    suggestions.add('Statement PDF');
  }
  for (const parser of IMPORT_PARSERS) {
    const parserInstitution = normalizedInstitution(parser.institution);
    if (!accountInstitution || !parserInstitution) continue;
    if (!accountInstitution.includes(parserInstitution) && !parserInstitution.includes(accountInstitution)) continue;
    if (!parserSupportsAccountType(parser, accountType)) continue;
    suggestions.add(parserDownloadLabel(parser));
  }
  return [...suggestions];
}

function originalImportFileName(fileName: string) {
  return fileName.replace(/^[0-9a-f]{64}-/, '');
}

export function resolveImportParser(file: { fileName: string; headers: string[]; sample: string }) {
  const matchFile = {
    ...file,
    fileName: originalImportFileName(file.fileName),
  };
  const hits = IMPORT_PARSERS.filter(parser => parser.matches(matchFile));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(`Multiple import parsers match ${file.fileName}: ${hits.map(hit => hit.id).join(', ')}`);
  }
  return null;
}
