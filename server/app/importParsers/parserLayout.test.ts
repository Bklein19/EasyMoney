import { expect, test } from 'bun:test';
import { parseVanguardStatementText } from './moneyParsers/vanguard-statement-pdf.ts';
import { parseWellsFargoStatementText } from './moneyParsers/wells-fargo-statement-pdf.ts';

test('Vanguard preserves wrapped securities and duplicate occurrences across page furniture', () => {
  const result = parseVanguardStatementText([
    'June 30, 2026, quarter-to-date statement',
    'Example Person',
    'Individual brokerage account—XXXX1234',
    'Completed transactions',
    '06/15 06/15 VMFXX VANGUARD FEDERAL MONEY Dividend $12.05',
    'MARKET FUND',
    'June 30, 2026, quarter-to-date statement',
    'Example Person',
    'Vanguard Personal Investor',
    'Page 6 of 10',
    'Account activity for Vanguard Brokerage Account—XXXX1234 continued',
    'Completed transactions continued',
    'Settlement date Trade date Symbol Name Transaction type Amount',
    '06/15 06/15 VMFXX VANGUARD FEDERAL MONEY Dividend $12.05',
    'MARKET FUND',
    'Page 7 of 10',
    'Electronic delivery and mail preferences',
  ].join('\n'));
  expect(result.transactions).toHaveLength(2);
  for (const transaction of result.transactions) {
    expect(transaction.description).toBe('VMFXX VANGUARD FEDERAL MONEY Dividend MARKET FUND');
    expect(transaction.amount_cents).toBe(1205);
    expect(transaction.date).toBe('2026-06-15');
  }
});

test('Wells retains description continuation after amount and ending balance columns', () => {
  const result = parseWellsFargoStatementText([
    'Wells Fargo Everyday Checking',
    'Account number: 1234',
    'Beginning balance on 11/27 $5,000.00',
    'Transaction history',
    '11/29 Example Payroll 1,000.00 6,000.00',
    'Example Person Reference ABC123',
    '11/30 Online Transfer Ref ABC456 100.00 5,900.00',
    'VISA Card Xxxxxxxxxxxx4793 on 11/30/24',
    'Totals',
    'Ending balance on 12/24 $5,900.00',
  ].join('\n'), 'wells-fargo-checking-1234-2024-12-24.pdf');
  expect(result.transactions.map(tx => [tx.description, tx.amount_cents])).toEqual([
    ['Example Payroll Example Person Reference ABC123', 100000],
    ['Online Transfer Ref ABC456 VISA Card Xxxxxxxxxxxx4793 on 11/30/24', -10000],
  ]);
});
