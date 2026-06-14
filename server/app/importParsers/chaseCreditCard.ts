import type { AppImportParseInput, AppImportParseResult, AppImportParser, ParsedImportRecord } from '../importTypes.ts';

export const chaseCreditCardParser: AppImportParser = {
  id: 'chase-credit-card-csv',
  name: 'Chase Credit Card',
  institution: 'Chase',
  matches: ({ headers }) => hasHeaders(headers, [
    'Transaction Date',
    'Post Date',
    'Description',
    'Category',
    'Type',
    'Amount',
  ]),
  parse,
};

function hasHeaders(headers: string[], expected: string[]) {
  const normalized = new Set(headers.map(header => header.trim().toLowerCase()));
  return expected.every(header => normalized.has(header.toLowerCase()));
}

function parseDate(value: string) {
  const [month, day, year] = value.split('/').map(Number);
  if (!month || !day || !year) throw new Error(`Invalid Chase CSV date: ${value}`);
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

function parseAmount(value: string) {
  const cleaned = String(value)
    .replace(/[$,\s]/g, '')
    .replace(/\(([^)]+)\)/, '-$1');
  const amount = Number.parseFloat(cleaned);
  if (!Number.isFinite(amount)) throw new Error(`Invalid Chase CSV amount: ${value}`);
  return Math.round(amount * 100) / 100;
}

function parseRow(row: Record<string, string>, sourceRowIndex: number): ParsedImportRecord | null {
  const date = row['Transaction Date']?.trim();
  const description = row.Description?.trim();
  const amount = row.Amount?.trim();
  if (!date || !description || !amount) return null;

  const parsedAmount = parseAmount(amount);

  return {
    sourceRowIndex,
    date: parseDate(date),
    amount: parsedAmount,
    description,
    merchant: description,
    originalDescription: description,
    originalCategory: row.Category?.trim() || null,
    type: parsedAmount >= 0 ? 'credit' : 'debit',
    transactionKind: parsedAmount > 0 ? 'card_payment' : null,
    status: 'cleared',
    notes: '',
  };
}

function parse(input: AppImportParseInput): AppImportParseResult {
  return {
    records: input.rows.map((row, index) => parseRow(row, index)),
  };
}
