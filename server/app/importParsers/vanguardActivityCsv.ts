import type { AppImportParseInput, AppImportParseResult, AppImportParser, ParsedImportTransaction } from '../importTypes.ts';
import { parseAmount, parseDate } from './csvMapping.ts';
import { normalizedHeader, parseCsvRows, rowRecord } from './csvRows.ts';

const TRANSACTION_HEADERS = [
  'account number',
  'trade date',
  'settlement date',
  'transaction type',
  'transaction description',
];

function accountName(fileName: string, accountNumber: string) {
  const last4 = accountNumber.replace(/\D/g, '').slice(-4);
  const prefix = /roth-ira/i.test(fileName)
    ? 'Roth IRA brokerage account'
    : /traditional-ira|trad-ira/i.test(fileName)
      ? 'Traditional IRA brokerage account'
      : 'Individual brokerage account';
  return last4 ? `${prefix}-XXXX${last4}` : prefix;
}

function transaction(input: AppImportParseInput, row: Record<string, string>, sourceRowIndex: number): ParsedImportTransaction | null {
  const date = parseDate(row['Trade Date']?.trim(), ['yyyy-MM-dd', 'MM/dd/yyyy', 'M/d/yyyy']);
  const amount = parseAmount(row['Net Amount']);
  const transactionType = row['Transaction Type']?.replace(/\s+/g, ' ').trim();
  const transactionDescription = row['Transaction Description']?.replace(/\s+/g, ' ').trim();
  if (!date || amount === null || (!transactionType && !transactionDescription)) return null;

  const description = [transactionType, transactionDescription].filter(Boolean).join(': ');
  return {
    sourceRowIndex,
    date: date.toISOString(),
    amountCents: Math.round(amount * 100),
    description,
    institution: 'Vanguard',
    account: accountName(input.fileName, row['Account Number'] ?? ''),
    sourceRole: 'activity',
    raw: {
      source: 'vanguard-activity-csv',
      settlementDate: row['Settlement Date']?.trim() || undefined,
      investmentName: row['Investment Name']?.trim() || undefined,
      symbol: row.Symbol?.trim() || undefined,
      shares: row.Shares?.trim() || undefined,
      principalAmount: row['Principal Amount']?.trim() || undefined,
      fees: row['Commissions and Fees']?.trim() || undefined,
    },
  };
}

export function parseVanguardActivityCsv(input: AppImportParseInput): AppImportParseResult {
  const rows = parseCsvRows(input.text);
  const headerIndex = rows.findIndex(row => TRANSACTION_HEADERS.every((header, index) => normalizedHeader(row[index]) === header));
  if (headerIndex < 0) return { transactions: [], balances: [] };
  const headers = rows[headerIndex]!;
  return {
    transactions: rows.slice(headerIndex + 1).map((row, index) => transaction(input, rowRecord(headers, row), index)),
    balances: [],
  };
}

export const vanguardActivityCsvParser: AppImportParser = {
  id: 'vanguard-activity-csv',
  name: 'Vanguard Activity CSV',
  institution: 'Vanguard',
  sourceType: 'activity-export',
  priority: 110,
  matches: ({ fileName, sample }) => (
    /\.csv$/i.test(fileName) &&
    /Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description/i.test(sample)
  ),
  parse: parseVanguardActivityCsv,
};
