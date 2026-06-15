import type { AppImportParseInput, AppImportParseResult, ImportProfile, ParsedImportTransaction } from '../importTypes.ts';
import { enhanceProfileWithHeaders, normalizeMappedCsvTransaction } from './csvMapping.ts';

export const CUSTOM_CSV_PARSER_ID = 'custom-csv';

function toParsedTransaction(
  row: Record<string, string>,
  profile: ImportProfile,
  sourceRowIndex: number
): ParsedImportTransaction | null {
  const normalized = normalizeMappedCsvTransaction(row, profile);
  if (!normalized) return null;

  return {
    sourceRowIndex,
    date: normalized.date,
    amountCents: Math.round(normalized.amount * 100),
    description: normalized.description,
    institution: profile.name || 'Custom CSV',
    account: null,
    sourceRole: 'activity',
    raw: {
      merchant: normalized.merchant,
      originalDescription: normalized.originalDescription,
      originalCategory: normalized.originalCategory,
      status: normalized.status,
      transactionKind: normalized.transactionKind,
      parser: CUSTOM_CSV_PARSER_ID,
    },
  };
}

export function parseCustomCsv(input: AppImportParseInput, profile: ImportProfile): AppImportParseResult {
  const resolvedProfile = enhanceProfileWithHeaders(profile, input.headers);
  return {
    transactions: input.rows.map((row, index) => toParsedTransaction(row, resolvedProfile, index)),
    balances: [],
  };
}
