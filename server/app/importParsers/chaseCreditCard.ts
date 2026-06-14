import type { AppImportParseInput, AppImportParseResult, AppImportParser, ParsedImportTransaction } from '../importTypes.ts';

export const chaseCreditCardParser: AppImportParser = {
  id: 'chase-credit-card-csv',
  name: 'Chase Credit Card',
  institution: 'Chase',
  sourceType: 'activity-export',
  priority: 100,
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

function parseAmountCents(value: string) {
  return Math.round(parseAmount(value) * 100);
}

function parseRow(row: Record<string, string>, sourceRowIndex: number): ParsedImportTransaction | null {
  const date = row['Transaction Date']?.trim();
  const description = row.Description?.trim();
  const amount = row.Amount?.trim();
  if (!date || !description || !amount) return null;

  return {
    sourceRowIndex,
    date: parseDate(date),
    amountCents: parseAmountCents(amount),
    description,
    institution: 'Chase',
    account: null,
    sourceRole: 'activity',
    raw: {
      transactionDate: row['Transaction Date'] || '',
      postDate: row['Post Date'] || '',
      description,
      category: row.Category || '',
      type: row.Type || '',
      amount,
    },
  };
}

function parse(input: AppImportParseInput): AppImportParseResult {
  return {
    transactions: input.rows.map((row, index) => parseRow(row, index)),
    balances: [],
  };
}
