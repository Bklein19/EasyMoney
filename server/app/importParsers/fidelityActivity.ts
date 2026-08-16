import type { AppImportParseInput, AppImportParseResult, AppImportParser, ParsedImportTransaction } from '../importTypes.ts';
import { parseAmount, parseDate } from './csvMapping.ts';
import { normalizedHeader, parseCsvRows, rowRecord } from './csvRows.ts';

const INVESTMENT_HEADERS = ['run date', 'action', 'symbol', 'description', 'type'];
const RETIREMENT_HEADERS = ['date', 'investment', 'transaction type', 'shares unit', 'amount'];

function findHeader(rows: string[][], expected: string[]) {
  return rows.findIndex(row => expected.every((header, index) => normalizedHeader(row[index]) === header));
}

function investmentTransaction(row: Record<string, string>, sourceRowIndex: number): ParsedImportTransaction | null {
  const date = parseDate(row['Run Date']?.trim(), ['MM/dd/yyyy', 'M/d/yyyy']);
  const amount = parseAmount(row['Amount ($)']);
  const action = row.Action?.replace(/\s+/g, ' ').trim();
  if (!date || amount === null || !action) return null;

  return {
    sourceRowIndex,
    date: date.toISOString(),
    amountCents: Math.round(amount * 100),
    description: action,
    institution: 'Fidelity',
    account: null,
    sourceRole: 'activity',
    raw: {
      source: 'fidelity-investment-activity-csv',
      symbol: row.Symbol?.trim() || undefined,
      securityDescription: row.Description?.trim() || undefined,
      quantity: row.Quantity?.trim() || undefined,
      fees: row['Fees ($)']?.trim() || undefined,
    },
  };
}

function retirementTransaction(row: Record<string, string>, sourceRowIndex: number): ParsedImportTransaction | null {
  const date = parseDate(row.Date?.trim(), ['MM/dd/yyyy', 'M/d/yyyy']);
  const amount = parseAmount(row['Amount ($)']);
  const transactionType = row['Transaction Type']?.replace(/\s+/g, ' ').trim();
  const investment = row.Investment?.replace(/\s+/g, ' ').trim();
  if (!date || amount === null || !transactionType) return null;

  return {
    sourceRowIndex,
    date: date.toISOString(),
    amountCents: Math.round(amount * 100),
    description: investment ? `${transactionType}: ${investment}` : transactionType,
    institution: 'Fidelity',
    account: null,
    sourceRole: 'activity',
    raw: {
      source: 'fidelity-retirement-activity-csv',
      transactionType,
      investment: investment || undefined,
      shares: row['Shares/Unit']?.trim() || undefined,
    },
  };
}

export function parseFidelityActivity(input: AppImportParseInput): AppImportParseResult {
  const rows = parseCsvRows(input.text);
  const investmentHeader = findHeader(rows, INVESTMENT_HEADERS);
  if (investmentHeader >= 0) {
    const headers = rows[investmentHeader]!;
    return {
      transactions: rows.slice(investmentHeader + 1).map((row, index) => investmentTransaction(rowRecord(headers, row), index)),
      balances: [],
    };
  }

  const retirementHeader = findHeader(rows, RETIREMENT_HEADERS);
  if (retirementHeader >= 0) {
    const headers = rows[retirementHeader]!;
    return {
      transactions: rows.slice(retirementHeader + 1).map((row, index) => retirementTransaction(rowRecord(headers, row), index)),
      balances: [],
    };
  }

  return { transactions: [], balances: [] };
}

export const fidelityActivityParser: AppImportParser = {
  id: 'fidelity-activity-csv',
  name: 'Fidelity Activity',
  institution: 'Fidelity',
  sourceType: 'activity-export',
  priority: 100,
  matches: ({ fileName, sample }) => (
    /\.csv$/i.test(fileName) && (
      /Run Date,Action,Symbol,Description,Type,Price \(\$\)/i.test(sample) ||
      /Date,Investment,Transaction Type,Shares\/Unit,Amount \(\$\)/i.test(sample)
    )
  ),
  parse: parseFidelityActivity,
};
