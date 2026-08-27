import { expect, test } from 'bun:test';
import { bofaCreditCardActivityParser, parseBofaCreditCardActivity } from './bofaCreditCardActivity.ts';
import { fidelityActivityParser, parseFidelityActivity } from './fidelityActivity.ts';
import { resolveImportParser } from './index.ts';
import { parseBofaDepositStatementText } from './moneyParsers/bofa-statement-pdf.ts';
import { parseWellsFargoStatementText } from './moneyParsers/wells-fargo-statement-pdf.ts';
import { parseVanguardActivityCsv, vanguardActivityCsvParser } from './vanguardActivityCsv.ts';

test('BofA credit card activity parser preserves charge and payment signs', () => {
  const headers = ['Posted Date', 'Reference Number', 'Payee', 'Address', 'Amount'];
  const fileName = 'bofa-credit-card-4321-current-to-2026-08-22.csv';
  expect(bofaCreditCardActivityParser.matches({ fileName, headers, sample: '' })).toBe(true);
  const result = parseBofaCreditCardActivity({
    fileName,
    headers,
    rows: [
      { 'Posted Date': '08/12/2026', 'Reference Number': '100', Payee: 'EXAMPLE MARKET', Address: 'CITY CA', Amount: '-5.55' },
      { 'Posted Date': '08/12/2026', 'Reference Number': '101', Payee: 'PAYMENT FROM CHK 1234', Address: '', Amount: '250.00' },
    ],
    text: '',
  });
  expect(result.transactions.map(transaction => transaction && ({ amount: transaction.amountCents, kind: transaction.raw?.transactionKind }))).toEqual([
    { amount: -555, kind: undefined },
    { amount: 25000, kind: 'card_payment' },
  ]);
  expect(result.transactions.every(transaction => transaction?.account === 'Credit Card - 4321')).toBe(true);
});

test('Fidelity activity parser supports brokerage and retirement exports', () => {
  const brokerage = [
    '\uFEFF',
    'Run Date,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date',
    '07/06/2026,JOURNALED TAX WITHHOLDING (Cash),,No Description,Cash,,0,,,,-21.96,1000.00,',
    '07/06/2026,YOU BOUGHT RSU EXAMPLE (Cash),EX,EXAMPLE INC,Cash,10,2,,,,0,1000.00,',
  ].join('\n');
  expect(fidelityActivityParser.matches({ fileName: 'fidelity-investment-activity.csv', headers: [], sample: brokerage })).toBe(true);
  expect(parseFidelityActivity({ fileName: 'fidelity-investment-activity.csv', headers: [], rows: [], text: brokerage }).transactions[0]).toMatchObject({
    amountCents: -2196,
    account: null,
    institution: 'Fidelity',
  });
  expect(parseFidelityActivity({ fileName: 'fidelity-investment-activity.csv', headers: [], rows: [], text: brokerage }).transactions.filter(Boolean)).toHaveLength(1);

  const retirement = [
    '\uFEFF',
    'Date,Investment,Transaction Type,Shares/Unit,Amount ($)',
    '07/30/2026,EXAMPLE INDEX,Contributions,5.266,1200.45',
  ].join('\n');
  expect(parseFidelityActivity({ fileName: 'fidelity-retirement-activity.csv', headers: [], rows: [], text: retirement }).transactions[0]).toMatchObject({
    amountCents: 120045,
    description: 'Contributions: EXAMPLE INDEX',
  });
});

test('Fidelity activity parser supports account-qualified brokerage exports after leading blank lines', () => {
  const brokerage = [
    '\uFEFF',
    '',
    'Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date',
    '08/20/2026,Example Brokerage,Z00-000000,DIVIDEND RECEIVED,EX,EXAMPLE FUND,Cash,0,0,0,0,0,12.34,08/20/2026',
  ].join('\n');

  expect(fidelityActivityParser.matches({
    fileName: 'fidelity-investment-activity.csv',
    headers: [],
    sample: brokerage,
  })).toBe(true);
  expect(parseFidelityActivity({
    fileName: 'fidelity-investment-activity.csv',
    headers: [],
    rows: [],
    text: brokerage,
  }).transactions.filter(Boolean)).toEqual([
    expect.objectContaining({
      amountCents: 1234,
      description: 'DIVIDEND RECEIVED',
      institution: 'Fidelity',
      account: 'Example Brokerage',
      remoteAccountId: 'fidelity:Z00000000',
    }),
  ]);
});

test('Fidelity activity parser rejects partial identity in an account-qualified export', () => {
  const brokerage = [
    'Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date',
    '08/20/2026,Example Brokerage,Z00-000000,DIVIDEND RECEIVED,EX,EXAMPLE FUND,Cash,0,0,0,0,0,12.34,08/20/2026',
    '08/21/2026,,,DIVIDEND RECEIVED,EX,EXAMPLE FUND,Cash,0,0,0,0,0,5.00,08/21/2026',
  ].join('\n');
  expect(() => parseFidelityActivity({
    fileName: 'fidelity-investment-activity.csv',
    headers: [],
    rows: [],
    text: brokerage,
  })).toThrow('missing a stable account identity');
});

test('Vanguard activity CSV parser skips holdings and parses the transaction section', () => {
  const text = [
    'Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,',
    '12345678,EXAMPLE FUND,VTI,1,100,100,',
    '',
    'Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type,',
    '12345678,2026-07-16,2026-07-16,Funds Received,Electronic Bank Transfer,CASH,,0,0,400.00,0,400.00,0,CASH,',
  ].join('\n');
  expect(vanguardActivityCsvParser.matches({ fileName: 'vanguard-brokerage-activity.csv', headers: [], sample: text })).toBe(true);
  expect(parseVanguardActivityCsv({ fileName: 'vanguard-brokerage-activity.csv', headers: [], rows: [], text }).transactions[0]).toMatchObject({
    amountCents: 40000,
    account: 'Individual brokerage account-XXXX5678',
    description: 'Funds Received: Electronic Bank Transfer',
  });
});

test('PII-free Fidelity report filename resolves from document structure', () => {
  const parser = resolveImportParser({
    fileName: 'fidelity-investment-report-2026-07.pdf',
    headers: [],
    sample: 'INVESTMENT REPORT\nJuly 1, 2026 - July 31, 2026\nAccount Number: Z00-000000\nYour Account Value: $1.00',
  });
  expect(parser?.id).toBe('fidelity-investment-report-pdf');
});

test('Sequoia Fund catch-up activity resolves through the public parser registry', () => {
  const parser = resolveImportParser({
    fileName: 'sequoia-fund-account-last4-1111-activity-2026-01-01-to-2026-08-23.csv',
    headers: ['Transaction Date', 'Transaction Type', 'Dollar Amount'],
    sample: 'Transaction Date,Transaction Type,Dollar Amount\n08/01/2026,Fund Purchase,400.00',
  });
  expect(parser?.id).toBe('sequoia-fund-activity-csv');
});

test('PII-free BofA and Wells Fargo statement filenames do not use the year as last four', () => {
  const bofa = parseBofaDepositStatementText([
    'Your Adv Plus Banking',
    'Account number: 0000 0000 4321',
    'for June 1, 2026 to June 30, 2026',
    'Ending balance on June 30, 2026 $1,000.00',
  ].join('\n'), 'bofa-checking-2026-06-statement.pdf');
  expect(bofa.balances[0]?.account).toBe('Adv Plus Banking - 4321');

  const wellsFargo = parseWellsFargoStatementText([
    'Wells Fargo Everyday Checking',
    'Account number: 0000004321',
    'Beginning balance on 4/24 $900.00',
    'Ending balance on 5/26 $1,000.00',
    'Transaction history',
  ].join('\n'), 'wells-fargo-checking-statement-2026-05-26.pdf');
  expect(wellsFargo.covered_to).toBe('2026-05-26');
  expect(wellsFargo.balances[0]?.account).toBe('Checking - 4321');
});
