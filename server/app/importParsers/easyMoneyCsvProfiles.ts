import type { AppImportParseInput, AppImportParseResult, AppImportParser, ImportProfile, ParsedImportTransaction } from '../importTypes.ts';
import { enhanceProfileWithHeaders, normalizeMappedCsvTransaction, type NormalizedCsvTransaction } from './csvMapping.ts';
import { robinhoodCreditCrossSourceIdentity } from './robinhoodCrossSourceIdentity.ts';

type EasyMoneyCsvProfile = ImportProfile & {
  headerFingerprint: string[];
  fileNamePatterns?: string[];
  requireFileNameMatch?: boolean;
  includedRowValues?: Record<string, string[]>;
  crossSourceIdentity?: (description: string) => string;
};

const EASYMONEY_CSV_PROFILES = [
  {
    name: 'American Express Credit Card',
    headerFingerprint: ['Date', 'Description', 'Amount'],
    fileNamePatterns: ['amex', 'american express'],
    requireFileNameMatch: true,
    statementType: 'credit_card',
    dateColumns: ['Date'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'single', column: 'Amount', positiveIsCharge: true },
    categoryColumn: null,
  },
  {
    name: 'Apple Card',
    headerFingerprint: ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)', 'Purchased By'],
    statementType: 'credit_card',
    dateColumns: ['Transaction Date'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Description',
    merchantColumn: 'Merchant',
    amountConfig: { type: 'single', column: 'Amount (USD)', positiveIsCharge: true },
    categoryColumn: 'Category',
  },
  {
    name: 'Capital One',
    headerFingerprint: ['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'],
    dateColumns: ['Transaction Date'],
    dateFormats: ['yyyy-MM-dd'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'split', debitColumn: 'Debit', creditColumn: 'Credit' },
    categoryColumn: 'Category',
  },
  {
    name: 'Citi',
    headerFingerprint: ['Status', 'Date', 'Description', 'Debit', 'Credit'],
    dateColumns: ['Date'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'split', debitColumn: 'Debit', creditColumn: 'Credit' },
    categoryColumn: null,
  },
  {
    name: 'Robinhood Credit Card',
    headerFingerprint: ['Date', 'Time', 'Cardholder', 'Amount', 'Points', 'Balance', 'Status', 'Type', 'Merchant', 'Description'],
    statementType: 'credit_card',
    dateColumns: ['Date'],
    dateFormats: ['yyyy-MM-dd'],
    descriptionColumn: 'Description',
    merchantColumn: 'Merchant',
    amountConfig: { type: 'single', column: 'Amount', positiveIsCharge: true },
    categoryColumn: null,
    includedRowValues: { Status: ['Posted'] },
    crossSourceIdentity: robinhoodCreditCrossSourceIdentity,
  },
] as EasyMoneyCsvProfile[];

function parserId(profileName: string) {
  return `${profileName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-csv`;
}

function hasHeaderFingerprint(headers: string[], profile: EasyMoneyCsvProfile) {
  const normalizedHeaders = new Set(headers.map(header => header.trim().toLowerCase()));
  return profile.headerFingerprint.every(header =>
    normalizedHeaders.has(header.toLowerCase())
  );
}

function hasRequiredFileName(fileName: string, profile: EasyMoneyCsvProfile) {
  const normalizedFileName = fileName.toLowerCase();
  const patterns = profile.fileNamePatterns || [];
  const fileNameMatches = !patterns.length || patterns.some(pattern => normalizedFileName.includes(pattern));
  return !profile.requireFileNameMatch || fileNameMatches;
}

function toParsedTransaction(
  normalized: NormalizedCsvTransaction | null,
  profile: EasyMoneyCsvProfile,
  sourceRowIndex: number
): ParsedImportTransaction | null {
  if (!normalized) return null;

  return {
    sourceRowIndex,
    date: normalized.date,
    amountCents: Math.round(normalized.amount * 100),
    description: normalized.description,
    institution: profile.name,
    account: null,
    sourceRole: 'activity',
    raw: {
      merchant: normalized.merchant,
      originalDescription: normalized.originalDescription,
      originalCategory: normalized.originalCategory,
      status: normalized.status,
      transactionKind: normalized.transactionKind,
      parser: parserId(profile.name),
      ...(profile.crossSourceIdentity
        ? { crossSourceIdentity: profile.crossSourceIdentity(normalized.originalDescription) }
        : {}),
    },
  };
}

function includesRow(row: Record<string, string>, profile: EasyMoneyCsvProfile): boolean {
  return Object.entries(profile.includedRowValues ?? {}).every(([column, included]) => {
    const value = row[column]?.trim().toLowerCase() ?? '';
    return included.some(candidate => candidate.toLowerCase() === value);
  });
}

function createEasyMoneyCsvParser(profile: EasyMoneyCsvProfile): AppImportParser {
  return {
    id: parserId(profile.name),
    name: profile.name,
    institution: profile.name,
    sourceType: 'activity-export',
    priority: 10,
    matches: ({ fileName, headers }) => (
      hasRequiredFileName(fileName, profile) && hasHeaderFingerprint(headers, profile)
    ),
    parse(input: AppImportParseInput): AppImportParseResult {
      const resolvedProfile = enhanceProfileWithHeaders(profile, input.headers);
      return {
        transactions: input.rows.map((row, index) => includesRow(row, profile)
          ? toParsedTransaction(normalizeMappedCsvTransaction(row, resolvedProfile), profile, index)
          : null),
        balances: [],
      };
    },
  };
}

export const easyMoneyCsvProfileParsers = EASYMONEY_CSV_PROFILES.map(createEasyMoneyCsvParser);

export const robinhoodCreditCardCsvParser = easyMoneyCsvProfileParsers.find(
  parser => parser.id === 'robinhood-credit-card-csv',
)!;
