import type { AppImportParseInput, AppImportParseResult, AppImportParser, ParsedImportTransaction } from '../importTypes.ts';
import { parseAmount, parseDate } from './csvMapping.ts';
import { normalizedHeader } from './csvRows.ts';

const EXPECTED_HEADERS = ['posted date', 'reference number', 'payee', 'address', 'amount'];

function hasHeaders(headers: string[]) {
  const normalized = headers.map(normalizedHeader);
  return EXPECTED_HEADERS.every((header, index) => normalized[index] === header);
}

function parseRow(row: Record<string, string>, sourceRowIndex: number): ParsedImportTransaction | null {
  const date = parseDate(row['Posted Date']?.trim(), ['MM/dd/yyyy', 'M/d/yyyy']);
  const amount = parseAmount(row.Amount);
  const description = row.Payee?.replace(/\s+/g, ' ').trim();
  if (!date || amount === null || !description) return null;

  return {
    sourceRowIndex,
    date: date.toISOString(),
    amountCents: Math.round(amount * 100),
    description,
    institution: 'Bank of America',
    account: null,
    sourceRole: 'activity',
    raw: {
      source: 'bofa-credit-card-csv',
      referenceNumber: row['Reference Number']?.trim() || undefined,
      address: row.Address?.replace(/\s+/g, ' ').trim() || undefined,
      transactionKind: /payment from/i.test(description) ? 'card_payment' : undefined,
    },
  };
}

export function parseBofaCreditCardActivity(input: AppImportParseInput): AppImportParseResult {
  return {
    transactions: input.rows.map((row, index) => parseRow(row, index)),
    balances: [],
  };
}

export const bofaCreditCardActivityParser: AppImportParser = {
  id: 'bofa-credit-card-activity-csv',
  name: 'Bank of America Credit Card Activity',
  institution: 'Bank of America',
  sourceType: 'activity-export',
  priority: 110,
  matches: ({ fileName, headers }) => /\.csv$/i.test(fileName) && hasHeaders(headers),
  parse: parseBofaCreditCardActivity,
};
