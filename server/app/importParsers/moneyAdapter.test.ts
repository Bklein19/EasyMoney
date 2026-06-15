import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveImportParser } from './index.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

test('money parser adapter translates money activity output to app import output', async () => {
  const parser = createMoneyParserAdapter({
    name: 'Test Money Parser',
    meta: {
      id: 'test-money-parser',
      institution: 'Vanguard',
      kind: 'activity-export',
      priority: 100,
      matches: ({ filename }) => filename === 'activity.pdf',
    },
    parseMoneyFile: async filePath => {
      expect(filePath).toBe('/tmp/activity.pdf');
      return {
        covered_from: '2026-06-01',
        covered_to: '2026-06-30',
        transactions: [
          {
            id: 'tx-1',
            date: '2026-06-14',
            amount_cents: -50000,
            description: 'Buy VTI',
            account: 'Brokerage-XXXX1234',
            institution: 'Vanguard',
            category: 'activity',
            raw: { row: 'raw activity row' },
          },
          {
            id: 'tx-2',
            date: '2026-06-20',
            amount_cents: 100000,
            description: 'Transfer of assets',
            account: 'Brokerage-XXXX1234',
            institution: 'Vanguard',
            category: 'in-kind-transfer',
            raw: { row: 'raw transfer row' },
          },
        ],
        balances: [
          {
            date: '2026-06-30',
            account: 'Brokerage-XXXX1234',
            institution: 'Vanguard',
            balance_cents: 1842000,
          },
        ],
      };
    },
  });

  expect(parser.matches({ fileName: 'activity.pdf', headers: [], sample: '' })).toBe(true);
  const result = await parser.parse({
    fileName: 'activity.pdf',
    headers: [],
    rows: [],
    text: '',
    filePath: '/tmp/activity.pdf',
  });

  expect(result.transactions).toEqual([
    {
      sourceRowIndex: 0,
      date: '2026-06-14',
      amountCents: -50000,
      description: 'Buy VTI',
      institution: 'Vanguard',
      account: 'Brokerage-XXXX1234',
      sourceRole: 'activity',
      raw: {
        moneyId: 'tx-1',
        moneyCategory: 'activity',
        row: 'raw activity row',
      },
    },
    {
      sourceRowIndex: 1,
      date: '2026-06-20',
      amountCents: 100000,
      description: 'Transfer of assets',
      institution: 'Vanguard',
      account: 'Brokerage-XXXX1234',
      sourceRole: 'statement-only',
      raw: {
        moneyId: 'tx-2',
        moneyCategory: 'in-kind-transfer',
        row: 'raw transfer row',
      },
    },
  ]);
  expect(result.balances).toEqual([
    {
      sourceRowIndex: 0,
      date: '2026-06-30',
      balanceCents: 1842000,
      institution: 'Vanguard',
      account: 'Brokerage-XXXX1234',
      raw: {},
    },
  ]);
});

test('import parser registry resolves Vanguard activity PDFs', () => {
  const parser = resolveImportParser({
    fileName: 'vanguard-1234-2026-01-01-to-2026-06-30-transaction-history.pdf',
    headers: [],
    sample: '',
  });

  expect(parser?.id).toBe('vanguard-activity-pdf');
  expect(parser?.sourceType).toBe('activity-export');
  expect(parser?.priority).toBe(100);
});

test('import parser registry resolves Vanguard statement PDFs', () => {
  const namedParser = resolveImportParser({
    fileName: 'vanguard-1234-2026-06-30-statement.pdf',
    headers: [],
    sample: '',
  });
  expect(namedParser?.id).toBe('vanguard-statement-pdf');
  expect(namedParser?.sourceType).toBe('statement');
  expect(namedParser?.priority).toBe(50);

  const contentParser = resolveImportParser({
    fileName: 'statement-4.pdf',
    headers: [],
    sample: 'Vanguard Brokerage Services',
  });
  expect(contentParser?.id).toBe('vanguard-statement-pdf');
});

test('import parser registry resolves Bank of America activity CSV exports', () => {
  const namedParser = resolveImportParser({
    fileName: 'bofa-checking-1234-2026-01-01-to-2026-06-30.csv',
    headers: [],
    sample: '',
  });
  expect(namedParser?.id).toBe('bofa-activity-csv');
  expect(namedParser?.sourceType).toBe('activity-export');
  expect(namedParser?.priority).toBe(100);

  const contentParser = resolveImportParser({
    fileName: 'download.csv',
    headers: [],
    sample: [
      'Description,,Summary Amt.',
      'Opening Balance,,"1,234.56"',
      'Date,Description,Amount,Running Bal.',
    ].join('\n'),
  });
  expect(contentParser?.id).toBe('bofa-activity-csv');
});

test('Bank of America activity adapter parses sanitized CSV exports', async () => {
  const parser = resolveImportParser({
    fileName: 'bofa-checking-1234-2026-01-01-to-2026-01-31.csv',
    headers: [],
    sample: '',
  });
  expect(parser?.id).toBe('bofa-activity-csv');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bofa-activity-test-'));
  const filePath = path.join(dir, 'bofa-checking-1234-2026-01-01-to-2026-01-31.csv');
  await fs.writeFile(filePath, [
    'Description,,Summary Amt.',
    'Opening Balance,,1000.00',
    'Date,Description,Amount,Running Bal.',
    '01/05/2026,ACME PAYROLL,2500.00,3500.00',
    '01/06/2026,UTILITY BILL,-125.50,3374.50',
  ].join('\n'));

  try {
    const result = await parser!.parse({
      fileName: path.basename(filePath),
      headers: [],
      rows: [],
      text: await fs.readFile(filePath, 'utf8'),
      filePath,
    });

    expect(result.transactions).toEqual([
      {
        sourceRowIndex: 0,
        date: '2026-01-05',
        amountCents: 250000,
        description: 'ACME PAYROLL',
        institution: 'Bank of America',
        account: 'Adv Plus Banking - 1234',
        sourceRole: 'activity',
        raw: {
          moneyId: result.transactions[0]?.raw?.moneyId,
          moneyCategory: 'activity',
          source: 'bofa-csv',
          runningBalance: '3500.00',
        },
      },
      {
        sourceRowIndex: 1,
        date: '2026-01-06',
        amountCents: -12550,
        description: 'UTILITY BILL',
        institution: 'Bank of America',
        account: 'Adv Plus Banking - 1234',
        sourceRole: 'activity',
        raw: {
          moneyId: result.transactions[1]?.raw?.moneyId,
          moneyCategory: 'activity',
          source: 'bofa-csv',
          runningBalance: '3374.50',
        },
      },
    ]);
    expect(result.balances).toEqual([
      {
        sourceRowIndex: 0,
        date: '2026-01-05',
        balanceCents: 350000,
        institution: 'Bank of America',
        account: 'Adv Plus Banking - 1234',
        raw: {},
      },
      {
        sourceRowIndex: 1,
        date: '2026-01-06',
        balanceCents: 337450,
        institution: 'Bank of America',
        account: 'Adv Plus Banking - 1234',
        raw: {},
      },
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('import parser registry resolves Bank of America statement PDFs', () => {
  const depositParser = resolveImportParser({
    fileName: 'bofa-checking-1234-2026-june-statement.pdf',
    headers: [],
    sample: '',
  });
  expect(depositParser?.id).toBe('bofa-statement-pdf');
  expect(depositParser?.sourceType).toBe('statement');
  expect(depositParser?.priority).toBe(50);

  const contentParser = resolveImportParser({
    fileName: 'statement.pdf',
    headers: [],
    sample: 'Bank of America Payment Information New Balance Total',
  });
  expect(contentParser?.id).toBe('bofa-statement-pdf');
});

test.each([
  ['American Express Credit Card', 'american-express-credit-card-csv', 'american express activity.csv', ['Date', 'Description', 'Amount']],
  ['Apple Card', 'apple-card-csv', 'apple-card.csv', ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)', 'Purchased By']],
  ['Capital One', 'capital-one-csv', 'capital-one.csv', ['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit']],
  ['Citi', 'citi-csv', 'citi.csv', ['Status', 'Date', 'Description', 'Debit', 'Credit']],
  ['Robinhood Credit Card', 'robinhood-credit-card-csv', 'robinhood.csv', ['Date', 'Time', 'Cardholder', 'Amount', 'Points', 'Balance', 'Status', 'Type', 'Merchant', 'Description']],
])('import parser registry resolves EasyMoney legacy CSV profile %s', (_name, expectedId, fileName, headers) => {
  const parser = resolveImportParser({
    fileName,
    headers,
    sample: '',
  });

  expect(parser?.id).toBe(expectedId);
  expect(parser?.sourceType).toBe('activity-export');
  expect(parser?.priority).toBe(10);
});

test('EasyMoney legacy CSV profile parser preserves credit-card semantics', async () => {
  const parser = resolveImportParser({
    fileName: 'apple-card.csv',
    headers: ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)', 'Purchased By'],
    sample: '',
  });

  const result = await parser!.parse({
    fileName: 'apple-card.csv',
    headers: ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)', 'Purchased By'],
    rows: [{
      'Transaction Date': '06/14/2026',
      'Clearing Date': '06/15/2026',
      Description: 'Coffee Shop',
      Merchant: 'Coffee Shop',
      Category: 'Food & Drink',
      Type: 'Purchase',
      'Amount (USD)': '6.75',
      'Purchased By': 'Primary',
    }],
    text: '',
  });

  expect(result.transactions).toEqual([{
    sourceRowIndex: 0,
    date: '2026-06-14T00:00:00.000Z',
    amountCents: -675,
    description: 'Coffee Shop',
    institution: 'Apple Card',
    account: null,
    sourceRole: 'activity',
    raw: {
      merchant: 'Coffee Shop',
      originalDescription: 'Coffee Shop',
      originalCategory: 'Food & Drink',
      status: 'cleared',
      transactionKind: null,
      legacyProfile: 'Apple Card',
    },
  }]);
  expect(result.balances).toEqual([]);
});
