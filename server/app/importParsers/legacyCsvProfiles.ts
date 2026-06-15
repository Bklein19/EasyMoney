import {
  enhanceProfileWithHeaders,
  normalizeTransaction,
} from '../../../src/utils/bankProfiles.js';
import { americanExpressProfiles } from '../../../src/import/parsers/profiles/americanExpress.js';
import { appleCardProfiles } from '../../../src/import/parsers/profiles/appleCard.js';
import { capitalOneProfiles } from '../../../src/import/parsers/profiles/capitalOne.js';
import { citiProfiles } from '../../../src/import/parsers/profiles/citi.js';
import { robinhoodProfiles } from '../../../src/import/parsers/profiles/robinhood.js';
import type { AppImportParseInput, AppImportParseResult, AppImportParser, ImportProfile, ParsedImportTransaction } from '../importTypes.ts';

type LegacyCsvProfile = ImportProfile & {
  headerFingerprint: string[];
  fileNamePatterns?: string[];
  requireFileNameMatch?: boolean;
};

type LegacyNormalizedTransaction = {
  date: string;
  amount: number;
  description?: string | null;
  merchant?: string | null;
  originalDescription?: string | null;
  originalCategory?: string | null;
  transactionKind?: string | null;
  status?: string | null;
};

const LEGACY_CSV_PROFILES = [
  ...americanExpressProfiles,
  ...appleCardProfiles,
  ...capitalOneProfiles,
  ...citiProfiles,
  ...robinhoodProfiles,
] as LegacyCsvProfile[];

function parserId(profileName: string) {
  return `${profileName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-csv`;
}

function hasHeaderFingerprint(headers: string[], profile: LegacyCsvProfile) {
  const normalizedHeaders = new Set(headers.map(header => header.trim().toLowerCase()));
  return profile.headerFingerprint.every(header =>
    normalizedHeaders.has(header.toLowerCase())
  );
}

function hasRequiredFileName(fileName: string, profile: LegacyCsvProfile) {
  const normalizedFileName = fileName.toLowerCase();
  const patterns = profile.fileNamePatterns || [];
  const fileNameMatches = !patterns.length || patterns.some(pattern => normalizedFileName.includes(pattern));
  return !profile.requireFileNameMatch || fileNameMatches;
}

function toParsedTransaction(
  normalized: LegacyNormalizedTransaction | null,
  profile: LegacyCsvProfile,
  sourceRowIndex: number
): ParsedImportTransaction | null {
  if (!normalized) return null;

  return {
    sourceRowIndex,
    date: normalized.date,
    amountCents: Math.round(normalized.amount * 100),
    description: normalized.description || '',
    institution: profile.name,
    account: null,
    sourceRole: 'activity',
    raw: {
      merchant: normalized.merchant || normalized.description || '',
      originalDescription: normalized.originalDescription || normalized.description || '',
      originalCategory: normalized.originalCategory || null,
      status: normalized.status || 'cleared',
      transactionKind: normalized.transactionKind || null,
      legacyProfile: profile.name,
    },
  };
}

function createLegacyCsvParser(profile: LegacyCsvProfile): AppImportParser {
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
        transactions: input.rows.map((row, index) =>
          toParsedTransaction(normalizeTransaction(row, resolvedProfile) as LegacyNormalizedTransaction | null, profile, index)
        ),
        balances: [],
      };
    },
  };
}

export const legacyCsvProfileParsers = LEGACY_CSV_PROFILES.map(createLegacyCsvParser);
