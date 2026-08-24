import type {
  AppImportParseInput,
  AppImportParseResult,
  AppImportParser,
  ParsedImportTransaction,
} from '../importTypes.ts';
import { parseAmount, parseDate } from './csvMapping.ts';
import { normalizedHeader, parseCsvRows, rowRecord } from './csvRows.ts';
import {
  isSequoiaFundActivityFileName,
  sequoiaFundSourceAccountName,
} from './sequoiaFundIdentity.ts';

const dateHeaders = ['date', 'transaction date', 'trade date', 'effective date'];
const amountHeaders = [
  'amount',
  'transaction amount',
  'dollar amount',
  'net amount',
  'gross amount',
  'principal amount',
  'total amount',
];
const typeHeaders = ['transaction type', 'activity type', 'type', 'activity'];
const descriptionHeaders = [
  'transaction description',
  'activity description',
  'description',
  'details',
  'fund name',
  'investment name',
];

type HeaderMap = {
  date: string;
  amount: string;
  type: string | null;
  description: string | null;
};

function matchingHeader(headers: string[], candidates: string[]): string | null {
  const index = headers.findIndex(header => candidates.includes(normalizedHeader(header)));
  return index >= 0 ? headers[index]! : null;
}

function headerMap(headers: string[]): HeaderMap | null {
  const date = matchingHeader(headers, dateHeaders);
  const amount = matchingHeader(headers, amountHeaders);
  const type = matchingHeader(headers, typeHeaders);
  const description = matchingHeader(headers, descriptionHeaders);
  if (!date || !amount || (!type && !description)) return null;
  return { date, amount, type, description };
}

function signedAmount(value: number, raw: string, description: string): number {
  if (value <= 0 || /^\s*[-(]/.test(raw)) return value;
  return /\b(?:withdrawal|redemption|redeemed|sale|sold|distribution|fee)\b/i.test(description)
    ? -value
    : value;
}

function parseTransaction(
  input: AppImportParseInput,
  row: Record<string, string>,
  headers: HeaderMap,
  sourceRowIndex: number,
): ParsedImportTransaction | null {
  const date = parseDate(row[headers.date]?.trim(), ['MM/dd/yyyy', 'M/d/yyyy', 'MM/dd/yy', 'M/d/yy', 'yyyy-MM-dd']);
  const rawAmount = row[headers.amount]?.trim() ?? '';
  const amount = parseAmount(rawAmount);
  const type = headers.type ? row[headers.type]?.replace(/\s+/g, ' ').trim() : '';
  const detail = headers.description ? row[headers.description]?.replace(/\s+/g, ' ').trim() : '';
  const description = [type, detail].filter((value, index, values) => value && values.indexOf(value) === index).join(': ');
  if (!date || amount === null || amount === 0 || !description) return null;

  return {
    sourceRowIndex,
    date: date.toISOString(),
    amountCents: Math.round(signedAmount(amount, rawAmount, description) * 100),
    description,
    institution: 'Sequoia Fund',
    account: sequoiaFundSourceAccountName(input.fileName),
    sourceRole: 'activity',
    raw: {
      source: 'sequoia-fund-activity-csv',
      transactionType: type || undefined,
    },
  };
}

export function parseSequoiaFundActivity(input: AppImportParseInput): AppImportParseResult {
  const rows = parseCsvRows(input.text);
  const headerIndex = rows.findIndex(row => headerMap(row) !== null);
  if (headerIndex < 0) throw new Error('Sequoia Fund activity CSV has no recognizable transaction header');
  const headers = rows[headerIndex]!;
  const mappedHeaders = headerMap(headers)!;
  return {
    transactions: rows
      .slice(headerIndex + 1)
      .map((row, index) => parseTransaction(input, rowRecord(headers, row), mappedHeaders, index)),
    balances: [],
  };
}

export const sequoiaFundActivityParser: AppImportParser = {
  id: 'sequoia-fund-activity-csv',
  name: 'Sequoia Fund Activity',
  institution: 'Sequoia Fund',
  sourceType: 'activity-export',
  priority: 110,
  matches: ({ fileName }) => isSequoiaFundActivityFileName(fileName),
  parse: parseSequoiaFundActivity,
};
