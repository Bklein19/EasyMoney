import type { AppImportParseInput, AppImportParseResult, AppImportParser, ParsedImportTransaction } from '../importTypes.ts';
import { parseAmount, parseDate } from './csvMapping.ts';

export const robinhoodBankingParser: AppImportParser = {
  id: 'robinhood-banking-csv',
  name: 'Robinhood Banking',
  institution: 'Robinhood',
  sourceType: 'activity-export',
  priority: 90,
  matches: ({ fileName, headers }) => (
    isUuidCsv(fileName) &&
    hasExactHeaders(headers, ['Date', 'Description', 'Amount'])
  ),
  parse,
};

function isUuidCsv(fileName: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$/i.test(fileName);
}

function hasExactHeaders(headers: string[], expected: string[]) {
  if (headers.length !== expected.length) return false;
  return expected.every((header, index) => headers[index]?.trim().toLowerCase() === header.toLowerCase());
}

function parseRow(row: Record<string, string>, sourceRowIndex: number): ParsedImportTransaction | null {
  const dateRaw = row.Date?.trim();
  const description = row.Description?.replace(/\s+/g, ' ').trim();
  const amountRaw = row.Amount?.trim();
  if (!dateRaw || !description || !amountRaw) return null;

  const date = parseDate(dateRaw, ['yyyy-MM-dd']);
  const amount = parseAmount(amountRaw);
  if (!date || amount === null) return null;

  return {
    sourceRowIndex,
    date: date.toISOString(),
    amountCents: Math.round(amount * 100),
    description,
    institution: 'Robinhood',
    account: null,
    sourceRole: 'activity',
    raw: {
      parser: 'robinhood-banking-csv',
    },
  };
}

function parse(input: AppImportParseInput): AppImportParseResult {
  return {
    transactions: input.rows.map((row, index) => parseRow(row, index)),
    balances: [],
  };
}
