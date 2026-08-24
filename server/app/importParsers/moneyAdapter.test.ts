import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveImportParser } from './index.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';
import { parseRobinhoodStatementText } from './moneyParsers/robinhood-statement-pdf.ts';
import { parseNetBenefitsStatementText } from './moneyParsers/fidelity-netbenefits-statement-pdf.ts';
import { parseFidelityPortfolioStatementText } from './moneyParsers/fidelity-portfolio-statement-pdf.ts';
import { parseWellsFargoStatementText } from './moneyParsers/wells-fargo-statement-pdf.ts';
import { parseMerrillCmaStatementText } from './moneyParsers/merrill-cma-statement-pdf.ts';
import { parseBofaDepositStatementText } from './moneyParsers/bofa-statement-pdf.ts';
import { parseVanguardAccountHolder } from './moneyParsers/vanguard-statement-pdf.ts';

test('Vanguard statement parser extracts the holder immediately before the account heading', () => {
  expect(parseVanguardAccountHolder([
    'Monthly statement',
    'Example Person',
    'Roth IRA brokerage account—XXXX1234',
  ].join('\n'))).toBe('Example Person');
  expect(parseVanguardAccountHolder('Monthly statement\nRoth IRA brokerage account—XXXX1234')).toBeNull();
});

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
            account_holder: 'Example Owner',
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
          {
            id: 'tx-3',
            date: '2026-06-21',
            amount_cents: 1250,
            description: 'Coffee shop',
            account: 'Credit Card - XXXX1234',
            institution: 'Test Bank',
            category: 'activity',
            raw: { type: 'credit-card-activity', section: 'Purchases' },
          },
          {
            id: 'tx-4',
            date: '2026-06-22',
            amount_cents: -50000,
            description: 'Online payment thank you',
            account: 'Credit Card - XXXX1234',
            institution: 'Test Bank',
            category: 'activity',
            raw: { type: 'credit-card-activity', section: 'Payments' },
          },
          {
            id: 'tx-5',
            date: '2026-06-30',
            amount_cents: 500000,
            description: 'Statement net cash flow',
            account: 'Brokerage-XXXX1234',
            institution: 'Vanguard',
            category: 'statement-summary',
            raw: { type: 'statement-cash-flow-summary', metric: 'netCashFlow' },
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

  expect(result).toMatchObject({
    coveredFrom: '2026-06-01',
    coveredTo: '2026-06-30',
  });
  expect(result.transactions).toEqual([
    {
      sourceRowIndex: 0,
      date: '2026-06-14',
      amountCents: -50000,
      description: 'Buy VTI',
      institution: 'Vanguard',
      account: 'Brokerage-XXXX1234',
      accountHolder: 'Example Owner',
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
    {
      sourceRowIndex: 2,
      date: '2026-06-21',
      amountCents: -1250,
      description: 'Coffee shop',
      institution: 'Test Bank',
      account: 'Credit Card - XXXX1234',
      sourceRole: 'activity',
      raw: {
        moneyId: 'tx-3',
        moneyCategory: 'activity',
        type: 'credit-card-activity',
        section: 'Purchases',
      },
    },
    {
      sourceRowIndex: 3,
      date: '2026-06-22',
      amountCents: 50000,
      description: 'Online payment thank you',
      institution: 'Test Bank',
      account: 'Credit Card - XXXX1234',
      sourceRole: 'activity',
      raw: {
        moneyId: 'tx-4',
        moneyCategory: 'activity',
        type: 'credit-card-activity',
        section: 'Payments',
      },
    },
    {
      sourceRowIndex: 4,
      date: '2026-06-30',
      amountCents: 500000,
      description: 'Statement net cash flow',
      institution: 'Vanguard',
      account: 'Brokerage-XXXX1234',
      sourceRole: 'statement-summary',
      raw: {
        moneyId: 'tx-5',
        moneyCategory: 'statement-summary',
        type: 'statement-cash-flow-summary',
        metric: 'netCashFlow',
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

test('Bank of America deposit statement parser ignores page continuation text', () => {
  const result = parseBofaDepositStatementText(`
Your Adv Plus Banking
Account number: 1234
for December 1, 2023 to December 31, 2023
Beginning balance on December 1, 2023 $1,000.00

Withdrawals and other subtractions
12/29/23 Online Banking transfer to BRK 8092 Confirmation# 1111111111 -$500.00
        continued on the next page
Total withdrawals and other subtractions -$500.00

Ending balance on December 31, 2023 $500.00
  `, 'bofa-checking-1234-2023-december-statement.pdf');

  expect(result.transactions).toHaveLength(1);
  expect(result.transactions[0]).toMatchObject({
    date: '2023-12-29',
    amount_cents: -50000,
    description: 'Online Banking transfer to BRK 8092 Confirmation# 1111111111',
    account: 'Adv Plus Banking - 1234',
    institution: 'Bank of America',
  });
  expect(result.transactions[0]?.description).not.toContain('continued on the next page');
});

test.each([
  ['Wells Fargo checking statement', 'wells-fargo-statement-pdf', 'wells-fargo-checking-2432-2026-02-25.pdf', 'statement', 50],
  ['Wells Fargo credit card statement', 'wells-fargo-statement-pdf', 'wells-fargo-autograph-visa-2856-2024-01-07.pdf', 'statement', 50],
  ['Morgan Stanley statement', 'morgan-stanley-pdf', 'morgan-stanley-0854-2024-02-29-consolidated-statement.pdf', 'statement', 50],
  ['Morgan Stanley activity export', 'morgan-stanley-activity-pdf', 'AllActivity.pdf', 'activity-export', 100],
  ['Fidelity 401(k)', 'fidelity-401k-html', 'fidelity-401k-examplepayroll-2026-03.html', 'statement', 50],
  ['Fidelity NetBenefits statement', 'fidelity-netbenefits-statement-pdf', '2024-04-April-ExampleCo-401k-Fidelity-NetBenefits-Statement.pdf', 'statement', 50],
  ['Fidelity portfolio statement', 'fidelity-portfolio-statement-pdf', '2023-01-Health-Savings-Account-111222333-Jan-Fidelity-Statement.pdf', 'statement', 50],
  ['Fidelity investment report', 'fidelity-investment-report-pdf', 'fidelity-Z19335125-2026-03-31.pdf', 'statement', 50],
  ['Marcus savings statement', 'marcus-statement-pdf', 'marcus-online-savings-7453-2026-04-01-statement.pdf', 'statement', 50],
  ['Merrill CMA statement', 'merrill-cma-statement-pdf', 'merrill-statement-2024-STMT_08302024_XXXXX092_CMAEdge.pdf', 'statement', 50],
  ['Sequoia Fund statement', 'sequoia-fund-pdf', 'sequoia-fund-2026-03-31.pdf', 'statement', 50],
  ['TIAA statement', 'tiaa-statement-pdf', 'tiaa-2024-04-01-retirement-q1-2024-1505352356.pdf', 'statement', 50],
  ['Robinhood statement', 'robinhood-statement-pdf', '3c3d0cdf-23cf-323b-a8c6-099c1a530672.pdf', 'statement', 50],
  ['Robinhood downloaded individual statement', 'robinhood-statement-pdf', 'April 2019 – Individual Investing Account Statement-.pdf', 'statement', 50],
  ['Robinhood downloaded retirement statement', 'robinhood-statement-pdf', 'April 2024 – Consolidated IRA Statement-.pdf', 'statement', 50],
] as const)('import parser registry resolves %s', (_name, expectedId, fileName, sourceType, priority) => {
  const parser = resolveImportParser({
    fileName,
    headers: [],
    sample: '',
  });

  expect(parser?.id).toBe(expectedId);
  expect(parser?.sourceType).toBe(sourceType);
  expect(parser?.priority).toBe(priority);
});

test('import parser registry resolves raw files with stored content-hash prefixes', () => {
  const parser = resolveImportParser({
    fileName: '013c8649ea149890da3193c2b041eec637f06191ebc3743617106beac8f8e95a-morgan-stanley-0854-2023-06-30-consolidated-statement.pdf',
    headers: [],
    sample: '',
  });

  expect(parser?.id).toBe('morgan-stanley-pdf');
});

test('import parser registry resolves Wells Fargo statements imported from folders', () => {
  const parser = resolveImportParser({
    fileName: 'wells-fargo-statements/checking-1234/wells-fargo-checking-1234-2019-01-28.pdf',
    headers: [],
    sample: 'Wells Fargo Everyday Checking Ending balance on 1/28 $2,564.53',
  });

  expect(parser?.id).toBe('wells-fargo-statement-pdf');
});

test('Wells Fargo checking statement parser infers signs from running balances', () => {
  const result = parseWellsFargoStatementText([
    'Wells Fargo Everyday Checking',
    'Account number: 1234',
    'Beginning balance on 10/26 $13,830.50',
    'Transaction history',
    '10/27 Mineraltree, Inc Quickbooks 191027 xxxxx2885 Example, Alex C 1,500.00',
    '10/28 Robinhood Debits xxxxx9769 Alex Example 420.00 13,410.50',
    '11/1 Venmo Cashout 211101 2222222222 Alex Example 572.20',
    '11/1 Barclaycard US Creditcard xxxxx7805 Alex Example 763.44 13,047.87',
    '11/10 National Grid NE Utilitypay Nov 21 04424212798 Alex Example 8.62 13,039.25',
    'Totals',
    'Ending balance on 11/24 $13,039.25',
  ].join('\n'), 'wells-fargo-statements/checking-1234/wells-fargo-checking-1234-2021-11-24.pdf');

  expect(result.transactions.map(transaction => ({
    date: transaction.date,
    amount_cents: transaction.amount_cents,
    description: transaction.description,
  }))).toEqual([{
    date: '2021-10-27',
    amount_cents: 150000,
    description: 'Mineraltree, Inc Quickbooks 191027 xxxxx2885 Example, Alex C',
  }, {
    date: '2021-10-28',
    amount_cents: -42000,
    description: 'Robinhood Debits xxxxx9769 Alex Example',
  }, {
    date: '2021-11-01',
    amount_cents: 57220,
    description: 'Venmo Cashout 211101 2222222222 Alex Example',
  }, {
    date: '2021-11-01',
    amount_cents: -76344,
    description: 'Barclaycard US Creditcard xxxxx7805 Alex Example',
  }, {
    date: '2021-11-10',
    amount_cents: -862,
    description: 'National Grid NE Utilitypay Nov 21 04424212798 Alex Example',
  }]);
  expect(result.balances).toEqual([{
    date: '2021-11-24',
    account: 'Checking - 1234',
    institution: 'Wells Fargo',
    balance_cents: 1303925,
  }]);
});

test('Wells Fargo checking statement parser keeps wrapped payroll rows with amount on following line', () => {
  const result = parseWellsFargoStatementText([
    'Wells Fargo Everyday Checking',
    'Account number: 1234',
    'Beginning balance on 11/27 $5,000.00',
    'Transaction history',
    'Date',
    'Check',
    'Number Description',
    'Deposits/',
    'Additions',
    'Withdrawals/',
    'Subtractions',
    'Ending daily',
    'balance',
    '11/29 Wells Fargo Rewards 95.81',
    '11/29 ExampleCo, I-Osv 4444444444 241129 EXAMPLE001 Alex',
    'Example',
    '3,693.20',
    '11/29 Online Transfer Ref #Ib0Qdy9W9V to Wells Fargo Active Cash',
    'VISA Card Xxxxxxxxxxxx4793 on 11/27/24',
    '7.99',
    '11/29 Applecard Gsbank Payment 112824 62110504 Alex Example 19.24 8,761.78',
    'Totals',
    'Ending balance on 12/24 $8,761.78',
  ].join('\n'), 'wells-fargo-statements/checking-1234/wells-fargo-checking-1234-2024-12-24.pdf');

  expect(result.transactions.map(transaction => ({
    date: transaction.date,
    amount_cents: transaction.amount_cents,
    description: transaction.description,
  }))).toEqual([{
    date: '2024-11-29',
    amount_cents: 9581,
    description: 'Wells Fargo Rewards',
  }, {
    date: '2024-11-29',
    amount_cents: 369320,
    description: 'ExampleCo, I-Osv 4444444444 241129 EXAMPLE001 Alex Example',
  }, {
    date: '2024-11-29',
    amount_cents: -799,
    description: 'Online Transfer Ref #Ib0Qdy9W9V to Wells Fargo Active Cash VISA Card Xxxxxxxxxxxx4793 on 11/27/24',
  }, {
    date: '2024-11-29',
    amount_cents: -1924,
    description: 'Applecard Gsbank Payment 112824 62110504 Alex Example',
  }]);
});

test('Wells Fargo checking statement parser reconciles wrapped deposits before the next ending balance', () => {
  const result = parseWellsFargoStatementText([
    'Wells Fargo Everyday Checking',
    'Account number: 1234',
    'Beginning balance on 4/24 $5,614.75',
    'Transaction history',
    'Date',
    'Check',
    'Number Description',
    'Deposits/',
    'Additions',
    'Withdrawals/',
    'Subtractions',
    'Ending daily',
    'balance',
    '5/26 Money Transfer authorized on 05/25 From Withjoy.Com',
    'Registry Payout CA S346145301728387 Card 1736',
    '450.00',
    '5/26 eDeposit IN Branch 05/26/26 05:03:12 PM 1234 Example',
    'Example Branch City ST 0000',
    '4,939.94',
    '5/26 Robinhood Card 3333333333 260526 Alex Example 574.28 10,430.41',
    'Totals',
    'Ending balance on 5/26 $10,430.41',
  ].join('\n'), 'wells-fargo-statements/checking-1234/wells-fargo-checking-1234-2026-05-26.pdf');

  expect(result.transactions.map(transaction => ({
    date: transaction.date,
    amount_cents: transaction.amount_cents,
    description: transaction.description,
  }))).toEqual([{
    date: '2026-05-26',
    amount_cents: 45000,
    description: 'Money Transfer authorized on 05/25 From Withjoy.Com Registry Payout CA S346145301728387 Card 1736',
  }, {
    date: '2026-05-26',
    amount_cents: 493994,
    description: 'eDeposit IN Branch 05/26/26 05:03:12 PM 1234 Example Example Branch City ST 0000',
  }, {
    date: '2026-05-26',
    amount_cents: -57428,
    description: 'Robinhood Card 3333333333 260526 Alex Example',
  }]);
});

test.each([
  ['American Express Credit Card', 'american-express-credit-card-csv', 'american express activity.csv', ['Date', 'Description', 'Amount']],
  ['Apple Card', 'apple-card-csv', 'apple-card.csv', ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)', 'Purchased By']],
  ['Capital One', 'capital-one-csv', 'capital-one.csv', ['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit']],
  ['Citi', 'citi-csv', 'citi.csv', ['Status', 'Date', 'Description', 'Debit', 'Credit']],
  ['Robinhood Credit Card', 'robinhood-credit-card-csv', 'robinhood.csv', ['Date', 'Time', 'Cardholder', 'Amount', 'Points', 'Balance', 'Status', 'Type', 'Merchant', 'Description']],
])('import parser registry resolves EasyMoney CSV profile %s', (_name, expectedId, fileName, headers) => {
  const parser = resolveImportParser({
    fileName,
    headers,
    sample: '',
  });

  expect(parser?.id).toBe(expectedId);
  expect(parser?.sourceType).toBe('activity-export');
  expect(parser?.priority).toBe(10);
});

test('Robinhood statement parser extracts account activity and closing portfolio balance', () => {
  const result = parseRobinhoodStatementText([
    '05/01/2026 to 05/31/2026',
    'Individual Account #:111112222',
    'Account Summary Opening Balance Closing Balance',
    'Portfolio Value $262,553.73 $406,184.35',
    'Account Activity',
    'Description Symbol Acct Type Transaction Date Qty Price Debit Credit',
    'AAPL 01/21/2028 Call $200.00 AAPL Margin BTO 05/05/2026 1 $104.00000 $10,400.04',
    'AMD 01/15/2027 Call $115.00 AMD Margin STC 05/05/2026 1 $242.00000 $24,199.45',
    'iShares 0-3 Month Treasury Bond',
    'CUSIP: 46436E718 SGOV Margin Buy 05/05/2026 81.214836 $100.42500 $8,156.00',
    'ACH Deposit Margin ACH 05/13/2026 $9,000.00',
    'Interest Payment Sweep INT 05/29/2026 $1.19',
    'Total Funds Paid and Received $10,400.04 $33,200.64',
  ].join('\n'));

  expect(result.covered_from).toBe('2026-05-01');
  expect(result.covered_to).toBe('2026-05-31');
  expect(result.balances).toEqual([{
    date: '2026-05-31',
    account: 'Robinhood Individual - 2222',
    institution: 'Robinhood',
    balance_cents: 40618435,
  }]);
  expect(result.transactions.map(transaction => ({
    date: transaction.date,
    amount_cents: transaction.amount_cents,
    description: transaction.description,
    account: transaction.account,
    action: transaction.raw.action,
    symbol: transaction.raw.symbol,
  }))).toEqual([
    {
      date: '2026-05-05',
      amount_cents: -1040004,
      description: 'BTO AAPL 01/21/2028 Call $200.00',
      account: 'Robinhood Individual - 2222',
      action: 'BTO',
      symbol: 'AAPL',
    },
    {
      date: '2026-05-05',
      amount_cents: 2419945,
      description: 'STC AMD 01/15/2027 Call $115.00',
      account: 'Robinhood Individual - 2222',
      action: 'STC',
      symbol: 'AMD',
    },
    {
      date: '2026-05-05',
      amount_cents: -815600,
      description: 'Buy iShares 0-3 Month Treasury Bond',
      account: 'Robinhood Individual - 2222',
      action: 'Buy',
      symbol: 'SGOV',
    },
    {
      date: '2026-05-13',
      amount_cents: 900000,
      description: 'ACH ACH Deposit',
      account: 'Robinhood Individual - 2222',
      action: 'ACH',
      symbol: null,
    },
    {
      date: '2026-05-29',
      amount_cents: 119,
      description: 'INT Interest Payment',
      account: 'Robinhood Individual - 2222',
      action: 'INT',
      symbol: null,
    },
  ]);
});

test('Robinhood statement parser preserves separate retirement accounts in consolidated PDFs', () => {
  const result = parseRobinhoodStatementText([
    '05/01/2026 to 05/31/2026',
    'Traditional IRA Account #:333334444',
    'Account Summary Opening Balance Closing Balance',
    'Portfolio Value $87,687.67 $94,596.54',
    'Account Activity',
    'Description Symbol Acct Type Transaction Date Qty Price Debit Credit',
    'SPY Cash Buy 05/01/2026 0.161739 $723.88000 $117.08',
    'GOOGL 01/15/2027 Call $215.00 GOOGL Cash STC 05/04/2026 1 $175.50000 $17,549.58',
    'Roth IRA Account #:555556666',
    'Account Summary Opening Balance Closing Balance',
    'Portfolio Value $99,953.48 $216,740.08',
    'Account Activity',
    'Description Symbol Acct Type Transaction Date Qty Price Debit Credit',
    'SNOW Margin Sell 04/30/2026 2.078241 $137.17000 $285.07',
    'SPY Margin Buy 05/04/2026 12 $718.00800 $8,616.10',
  ].join('\n'));

  expect(result.balances).toEqual([{
    date: '2026-05-31',
    account: 'Robinhood Traditional IRA - 4444',
    institution: 'Robinhood',
    balance_cents: 9459654,
  }, {
    date: '2026-05-31',
    account: 'Robinhood Roth IRA - 6666',
    institution: 'Robinhood',
    balance_cents: 21674008,
  }]);
  expect(result.transactions.map(transaction => ({
    amount_cents: transaction.amount_cents,
    account: transaction.account,
    action: transaction.raw.action,
    symbol: transaction.raw.symbol,
  }))).toEqual([{
    amount_cents: -11708,
    account: 'Robinhood Traditional IRA - 4444',
    action: 'Buy',
    symbol: 'SPY',
  }, {
    amount_cents: 1754958,
    account: 'Robinhood Traditional IRA - 4444',
    action: 'STC',
    symbol: 'GOOGL',
  }, {
    amount_cents: 28507,
    account: 'Robinhood Roth IRA - 6666',
    action: 'Sell',
    symbol: 'SNOW',
  }, {
    amount_cents: -861610,
    account: 'Robinhood Roth IRA - 6666',
    action: 'Buy',
    symbol: 'SPY',
  }]);
});

test('Robinhood statement parser normalizes personal account holder headings to individual accounts', () => {
  const result = parseRobinhoodStatementText([
    '01/01/2025 to 01/31/2025',
    'Alex Example Account #:111112222',
    'Account Summary Opening Balance Closing Balance',
    'Portfolio Value $50,037.95 $53,860.28',
    'Account Activity',
    'Description Symbol Acct Type Transaction Date Qty Price Debit Credit',
    'INTC 02/07/2025 Put $20.00 INTC Margin STO 01/03/2025 1 $2.50000 $249.92',
  ].join('\n'));

  expect(result.balances[0]?.account).toBe('Robinhood Individual - 2222');
  expect(result.balances[0]?.account_holder).toBe('Alex Example');
  expect(result.transactions[0]?.account).toBe('Robinhood Individual - 2222');
  expect(result.transactions[0]?.account_holder).toBe('Alex Example');
});

test('Fidelity NetBenefits statement parser extracts contributions and balance', () => {
  const result = parseNetBenefitsStatementText([
    'Statement Details',
    'ExampleCo 401(k) Plan Retirement Savings Statement',
    'Your Account Summary',
    'Statement Period: 04/01/2024 to 04/30/2024',
    'Beginning Balance $0.00',
    'Your Contributions $983.35',
    'Employer Contributions $196.67',
    'Change in Market Value $0.38',
    'Ending Balance $1,180.40',
  ].join('\n'));

  expect(result.covered_from).toBe('2024-04-01');
  expect(result.covered_to).toBe('2024-04-30');
  expect(result.balances).toEqual([{
    date: '2024-04-30',
    account: 'ExampleCo 401(k)',
    institution: 'Fidelity',
    balance_cents: 118040,
  }]);
  expect(result.transactions.map(transaction => ({
    date: transaction.date,
    amountCents: transaction.amount_cents,
    description: transaction.description,
    account: transaction.account,
    institution: transaction.institution,
    rawType: transaction.raw.type,
  }))).toEqual([
    {
      date: '2024-04-30',
      amountCents: 98335,
      description: '401(k) contributions (employee)',
      account: 'ExampleCo 401(k)',
      institution: 'Fidelity',
      rawType: 'employee-contributions',
    },
    {
      date: '2024-04-30',
      amountCents: 19667,
      description: '401(k) contributions (employer)',
      account: 'ExampleCo 401(k)',
      institution: 'Fidelity',
      rawType: 'employer-contributions',
    },
  ]);
});

test('Fidelity portfolio statement parser extracts account contributions and balance', () => {
  const result = parseFidelityPortfolioStatementText([
    'INVESTMENT REPORT',
    'January 1, 2023 - January 31, 2023',
    'FIDELITY HEALTH SAVINGS ACCOUNT ALEX EXAMPLE HEALTH',
    'SAVINGS ACCOUNT FIDELITY PERSONAL TRUST CO - CUSTODIAN',
    'Account Number: 111-222333',
    'Your Account Value: $3,500.81',
    'Account Summary',
    'ALEX EXAMPLE - HEALTH SAVINGS ACCOUNT',
    'Contributions',
    'Date Reference Description Amount',
    '01/25 Employer Cur Yr $62.50',
    '01/25 Participant Cur Yr 129.17',
    '01/26 Transfer Of Assets Check Received Wexhealthinc 3,272.01',
    'Total Contributions $3,463.68',
  ].join('\n'));

  expect(result.covered_from).toBe('2023-01-01');
  expect(result.covered_to).toBe('2023-01-31');
  expect(result.balances).toEqual([{
    date: '2023-01-31',
    account: 'Health Savings Account 111222333',
    institution: 'Fidelity',
    balance_cents: 350081,
  }]);
  expect(result.transactions.map(transaction => ({
    date: transaction.date,
    amountCents: transaction.amount_cents,
    description: transaction.description,
    account: transaction.account,
  }))).toEqual([
    {
      date: '2023-01-25',
      amountCents: 6250,
      description: 'Fidelity contribution: Employer Cur Yr',
      account: 'Health Savings Account 111222333',
    },
    {
      date: '2023-01-25',
      amountCents: 12917,
      description: 'Fidelity contribution: Participant Cur Yr',
      account: 'Health Savings Account 111222333',
    },
    {
      date: '2023-01-26',
      amountCents: 327201,
      description: 'Fidelity contribution: Transfer Of Assets Check Received Wexhealthinc',
      account: 'Health Savings Account 111222333',
    },
  ]);
});

test('Fidelity portfolio statement parser extracts transfer-out flows', () => {
  const result = parseFidelityPortfolioStatementText([
    'INVESTMENT REPORT',
    'April 1, 2024 - April 30, 2024',
    'FIDELITY ROTH IRA ALEX EXAMPLE',
    'Account Number: 444-555666',
    'Your Account Value: $520.74',
    'Account Summary',
    'ALEX EXAMPLE - ROTH IRA',
    'Beginning Account Value $37,601.35',
    'Subtractions -36,266.85 -36,266.85',
    'Distributions -21.22 -21.22',
    'Securities Transferred Out -36,245.63 -36,245.63',
    'Change in Investment Value * -813.76',
    'Ending Account Value $520.74',
    'Distributions',
    'Date Reference Description Amount',
    '04/22 Transfer Of Assets ACAT DELIVER -$21.22',
    'Total Distributions -$21.22',
    'Securities Transferred Out',
    '04/22 ALPHABET INC CAP STK CL A Transfer Of Assets -32.000 $156.28000 -',
    'ACAT DELIVER VALUE OF TRANSACTION $5,000.96',
    'Total Securities Transferred Out -',
  ].join('\n'));

  expect(result.covered_from).toBe('2024-04-01');
  expect(result.covered_to).toBe('2024-04-30');
  expect(result.balances).toEqual([{
    date: '2024-04-30',
    account: 'Roth Ira 444555666',
    institution: 'Fidelity',
    balance_cents: 52074,
  }]);
  expect(result.transactions.map(transaction => ({
    date: transaction.date,
    amountCents: transaction.amount_cents,
    description: transaction.description,
    account: transaction.account,
    rawType: transaction.raw.type,
  }))).toEqual([{
    date: '2024-04-22',
    amountCents: -2122,
    description: 'Fidelity transfer out: Transfer Of Assets ACAT DELIVER',
    account: 'Roth Ira 444555666',
    rawType: 'distribution',
  }, {
    date: '2024-04-22',
    amountCents: -3624563,
    description: 'Fidelity transfer out: securities transferred out',
    account: 'Roth Ira 444555666',
    rawType: 'securities-transferred-out',
  }]);
});

test('import parser registry resolves Robinhood statement first-page samples', () => {
  const parser = resolveImportParser({
    fileName: 'statement.pdf',
    headers: [],
    sample: [
      'Robinhood',
      '04/01/2019 to 04/30/2019',
      'Alex Example Account #:111112222',
      'Account Summary OPENING BALANCE CLOSING BALANCE',
      'Portfolio Value $705.82 $728.20',
    ].join('\n'),
  });

  expect(parser?.id).toBe('robinhood-statement-pdf');
});

test('Robinhood statement parser handles older Roth IRA statement layouts', () => {
  const result = parseRobinhoodStatementText([
    '2024-04-01 to 2024-04-30',
    'ALEX EXAMPLE Account #:555556666',
    'Roth IRA',
    'Account Summary Opening',
    'Balance',
    'Closing',
    'Balance',
    'Portfolio Value $0.00 $35,653.05',
    'Account Activity',
    'Description Symbol Acct Type Trans Type Record Date Qty Price Debit Credit',
    'ACAT IN control_num = 20241070049362, firm_id = 0226, acct_num = 444555666 Cash ACATI 4/22/2024 $21.22',
    'Interest on Contribution (IRA Match) Cash MTCH 4/22/2024 $1,082.71',
    'SPDR S&P 500 ETF',
    'CUSIP: 78462F103',
    'SPY Cash Buy 4/22/2024 2.22387 $496.40 $1,103.93',
    'SPDR S&P 500 ETF',
    'CUSIP: 78462F103',
    'Cash ACATI 4/22/2024 11',
  ].join('\n'));

  expect(result.covered_from).toBe('2024-04-01');
  expect(result.covered_to).toBe('2024-04-30');
  expect(result.balances).toEqual([{
    date: '2024-04-30',
    account: 'Robinhood Roth IRA - 6666',
    institution: 'Robinhood',
    balance_cents: 3565305,
  }]);
  expect(result.transactions.map(transaction => ({
    date: transaction.date,
    amount_cents: transaction.amount_cents,
    description: transaction.description,
    account: transaction.account,
    action: transaction.raw.action,
    symbol: transaction.raw.symbol,
    accountType: transaction.raw.accountType,
  }))).toEqual([{
    date: '2024-04-22',
    amount_cents: 2122,
    description: 'ACATI ACAT IN control_num = 20241070049362, firm_id = 0226, acct_num = 444555666',
    account: 'Robinhood Roth IRA - 6666',
    action: 'ACATI',
    symbol: null,
    accountType: 'Cash',
  }, {
    date: '2024-04-22',
    amount_cents: 108271,
    description: 'MTCH Interest on Contribution (IRA Match)',
    account: 'Robinhood Roth IRA - 6666',
    action: 'MTCH',
    symbol: null,
    accountType: 'Cash',
  }, {
    date: '2024-04-22',
    amount_cents: -110393,
    description: 'Buy SPDR S&P 500 ETF',
    account: 'Robinhood Roth IRA - 6666',
    action: 'Buy',
    symbol: 'SPY',
    accountType: 'Cash',
  }]);
});

test('Robinhood statement parser extracts direct rollover contribution rows', () => {
  const result = parseRobinhoodStatementText([
    '2024-05-01 to 2024-05-31',
    'ALEX EXAMPLE Account #:555556666',
    'Roth IRA',
    'Account Summary Opening Balance Closing Balance',
    'Portfolio Value $35,653.05 $60,096.67',
    'Account Activity',
    'Description Symbol Acct Type Trans Type Record Date Qty Price Debit Credit',
    'Direct Rollover Check Received as of 2024-05-22 Cash DRFRO 5/23/2024 $21,685.84',
  ].join('\n'));

  expect(result.transactions.map(transaction => ({
    date: transaction.date,
    amount_cents: transaction.amount_cents,
    description: transaction.description,
    account: transaction.account,
    action: transaction.raw.action,
    symbol: transaction.raw.symbol,
    accountType: transaction.raw.accountType,
  }))).toEqual([{
    date: '2024-05-23',
    amount_cents: 2168584,
    description: 'DRFRO Direct Rollover Check Received as of 2024-05-22',
    account: 'Robinhood Roth IRA - 6666',
    action: 'DRFRO',
    symbol: null,
    accountType: 'Cash',
  }]);
});

test('import parser registry resolves Robinhood banking UUID exports', async () => {
  const parser = resolveImportParser({
    fileName: '26611d63-2108-411a-8e6d-faa71d80999c.csv',
    headers: ['Date', 'Description', 'Amount'],
    sample: 'Date,Description,Amount',
  });

  expect(parser?.id).toBe('robinhood-banking-csv');
  expect(parser?.sourceType).toBe('activity-export');
  expect(parser?.priority).toBe(90);

  const result = await parser!.parse({
    fileName: '26611d63-2108-411a-8e6d-faa71d80999c.csv',
    headers: ['Date', 'Description', 'Amount'],
    rows: [{
      Date: '2026-06-01',
      Description: 'Incoming transfer',
      Amount: '100.00',
    }, {
      Date: '2026-06-02',
      Description: 'Card purchase',
      Amount: '-12.34',
    }],
    text: '',
  });

  expect(result.transactions).toEqual([{
    sourceRowIndex: 0,
    date: '2026-06-01T00:00:00.000Z',
    amountCents: 10000,
    description: 'Incoming transfer',
    institution: 'Robinhood',
    account: null,
    sourceRole: 'activity',
    raw: {
      parser: 'robinhood-banking-csv',
    },
  }, {
    sourceRowIndex: 1,
    date: '2026-06-02T00:00:00.000Z',
    amountCents: -1234,
    description: 'Card purchase',
    institution: 'Robinhood',
    account: null,
    sourceRole: 'activity',
    raw: {
      parser: 'robinhood-banking-csv',
    },
  }]);
});

test('EasyMoney CSV profile parser preserves credit-card semantics', async () => {
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
      parser: 'apple-card-csv',
    },
  }]);
  expect(result.balances).toEqual([]);
});

test.each([
  ['Wells Fargo Activity', 'wells-fargo-activity-csv', 'wells-fargo-checking-1234-2026-01-01-to-2026-01-31.csv', ['DATE', 'DESCRIPTION', 'AMOUNT', 'CHECK #', 'STATUS']],
  ['Merrill Activity', 'merrill-activity-csv', 'merrill-activity-2026.csv', ['Trade Date', 'Settlement Date', 'Pending/Settled', 'Account Nickname', 'Account Registration', 'Account #', 'Type', 'Description 1', 'Description 2', 'Symbol/CUSIP #', 'Quantity', 'Price ($)', 'Amount ($)']],
  ['TIAA Activity', 'tiaa-activity-csv', 'tiaa-retirement-annuity-2026.csv', ['Date', 'AccountId', 'Action', 'Security', 'Price', 'Quantity', 'Amount', 'Text', 'Memo', 'Commission']],
])('import parser registry resolves money CSV parser %s', (_name, expectedId, fileName, headers) => {
  const parser = resolveImportParser({
    fileName,
    headers,
    sample: headers.join(','),
  });

  expect(parser?.id).toBe(expectedId);
  expect(parser?.sourceType).toBe('activity-export');
  expect(parser?.priority).toBe(100);
});

test.each([
  ['Wells Fargo default checking export', 'Checking.csv', ['Date', 'Description', 'Amount', 'CheckNumber', 'Status']],
  ['Wells Fargo default credit card export', 'CreditCard.csv', ['DATE', 'DESCRIPTION', 'AMOUNT', 'CHECK #', 'STATUS']],
])('import parser registry resolves generic Wells Fargo CSV parser for %s', (_name, fileName, headers) => {
  const parser = resolveImportParser({
    fileName,
    headers,
    sample: headers.join(','),
  });

  expect(parser?.id).toBe('wells-fargo-generic-activity-csv');
  expect(parser?.sourceType).toBe('activity-export');
  expect(parser?.priority).toBe(90);
});

test('Wells Fargo activity adapter parses account and liability semantics', async () => {
  const parser = resolveImportParser({
    fileName: 'wells-fargo-autograph-visa-4321-2026-01-01-to-2026-01-31.csv',
    headers: ['DATE', 'DESCRIPTION', 'AMOUNT', 'CHECK #', 'STATUS'],
    sample: '',
  });
  expect(parser?.id).toBe('wells-fargo-activity-csv');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wells-fargo-activity-test-'));
  const filePath = path.join(dir, 'wells-fargo-autograph-visa-4321-2026-01-01-to-2026-01-31.csv');
  await fs.writeFile(filePath, [
    'DATE,DESCRIPTION,AMOUNT,CHECK #,STATUS',
    '01/05/2026,COFFEE SHOP,-6.75,,Posted',
    '01/06/2026,AUTOMATIC PAYMENT,100.00,,Posted',
    '01/07/2026,PENDING AUTH,-12.00,,Pending',
  ].join('\n'));

  try {
    const result = await parser!.parse({
      fileName: path.basename(filePath),
      headers: ['DATE', 'DESCRIPTION', 'AMOUNT', 'CHECK #', 'STATUS'],
      rows: [],
      text: await fs.readFile(filePath, 'utf8'),
      filePath,
    });

    expect(result.transactions).toEqual([{
      sourceRowIndex: 0,
      date: '2026-01-05',
      amountCents: -675,
      description: 'COFFEE SHOP',
      institution: 'Wells Fargo',
      account: 'Autograph Visa - 4321',
      sourceRole: 'activity',
      raw: {
        moneyId: result.transactions[0]?.raw?.moneyId,
        moneyCategory: 'activity',
        source: 'wells-fargo-csv',
        checkNumber: undefined,
        status: 'Posted',
      },
    }, {
      sourceRowIndex: 1,
      date: '2026-01-06',
      amountCents: 10000,
      description: 'AUTOMATIC PAYMENT',
      institution: 'Wells Fargo',
      account: 'Autograph Visa - 4321',
      sourceRole: 'activity',
      raw: {
        moneyId: result.transactions[1]?.raw?.moneyId,
        moneyCategory: 'activity',
        source: 'wells-fargo-csv',
        checkNumber: undefined,
        status: 'Posted',
      },
    }]);
    expect(result.balances).toEqual([]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generic Wells Fargo CSV parser parses default checking export without inferring account', async () => {
  const parser = resolveImportParser({
    fileName: 'Checking.csv',
    headers: ['Date', 'Description', 'Amount', 'CheckNumber', 'Status'],
    sample: 'Date,Description,Amount,CheckNumber,Status',
  });
  expect(parser?.id).toBe('wells-fargo-generic-activity-csv');

  const result = await parser!.parse({
    fileName: 'Checking.csv',
    headers: ['Date', 'Description', 'Amount', 'CheckNumber', 'Status'],
    rows: [{
      Date: '01/05/2026',
      Description: 'ACME PAYROLL',
      Amount: '2500.00',
      CheckNumber: '',
      Status: 'Posted',
    }, {
      Date: '01/06/2026',
      Description: 'UTILITY BILL',
      Amount: '-125.50',
      CheckNumber: '',
      Status: 'Posted',
    }],
    text: '',
  });

  expect(result.transactions.filter(transaction => transaction !== null).map(transaction => ({
    date: transaction.date,
    amountCents: transaction.amountCents,
    account: transaction.account,
    description: transaction.description,
  }))).toEqual([
    {
      date: '2026-01-05T00:00:00.000Z',
      amountCents: 250000,
      account: null,
      description: 'ACME PAYROLL',
    },
    {
      date: '2026-01-06T00:00:00.000Z',
      amountCents: -12550,
      account: null,
      description: 'UTILITY BILL',
    },
  ]);
});

test('Merrill activity adapter parses investment CSV rows', async () => {
  const parser = resolveImportParser({
    fileName: 'merrill-activity-2026.csv',
    headers: ['Trade Date', 'Settlement Date', 'Pending/Settled', 'Account Nickname', 'Account Registration', 'Account #', 'Type', 'Description 1', 'Description 2', 'Symbol/CUSIP #', 'Quantity', 'Price ($)', 'Amount ($)'],
    sample: '',
  });
  expect(parser?.id).toBe('merrill-activity-csv');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'merrill-activity-test-'));
  const filePath = path.join(dir, 'merrill-activity-2026.csv');
  await fs.writeFile(filePath, [
    '"Trade Date","Settlement Date","Pending/Settled","Account Nickname","Account Registration","Account #","Type","Description 1","Description 2","Symbol/CUSIP #","Quantity","Price ($)","Amount ($)"',
    '"01/05/2026","01/06/2026","Settled","Taxable","Individual","1234","DividendAndInterest","Dividend","VTI","VTI","0","0","12.34"',
  ].join('\n'));

  try {
    const result = await parser!.parse({
      fileName: path.basename(filePath),
      headers: ['Trade Date', 'Settlement Date', 'Pending/Settled', 'Account Nickname', 'Account Registration', 'Account #', 'Type', 'Description 1', 'Description 2', 'Symbol/CUSIP #', 'Quantity', 'Price ($)', 'Amount ($)'],
      rows: [],
      text: await fs.readFile(filePath, 'utf8'),
      filePath,
    });

    expect(result.transactions[0]).toMatchObject({
      sourceRowIndex: 0,
      date: '2026-01-06',
      amountCents: 1234,
      description: 'Dividend | VTI | VTI | DividendAndInterest',
      institution: 'Merrill',
      account: 'Individual - 1234',
      sourceRole: 'activity',
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Merrill statement parser emits net cash flow as a statement summary transaction', () => {
  const result = parseMerrillCmaStatementText(`
    CMA® ACCOUNT
    Account Number: 11W-22222
    Net Cash Flow $5,000.00
    Dividends/Interest Income $12.34
    Closing Value (06/28) $123,456.78
  `, '2024-06-28');

  expect(result.balances).toEqual([
    {
      date: '2024-06-28',
      account: 'CMA-Edge - 11W-22222',
      institution: 'Merrill',
      balance_cents: 12345678,
    },
  ]);
  expect(result.transactions).toHaveLength(2);
  expect(result.transactions[0]).toMatchObject({
    date: '2024-06-28',
    amount_cents: 500000,
    account: 'CMA-Edge - 11W-22222',
    institution: 'Merrill',
    description: 'Statement net cash flow',
    category: 'statement-summary',
    raw: {
      type: 'statement-cash-flow-summary',
      metric: 'netCashFlow',
    },
  });
  expect(result.transactions[1]).toMatchObject({
    date: '2024-06-28',
    amount_cents: 1234,
    account: 'CMA-Edge - 11W-22222',
    institution: 'Merrill',
    description: 'Statement dividends/interest income',
    raw: {
      type: 'statement-cash-flow-summary',
      metric: 'dividendsInterestIncome',
    },
  });
});

test('TIAA activity adapter parses retirement CSV rows', async () => {
  const parser = resolveImportParser({
    fileName: 'tiaa-retirement-annuity-2026.csv',
    headers: ['Date', 'AccountId', 'Action', 'Security', 'Price', 'Quantity', 'Amount', 'Text', 'Memo', 'Commission'],
    sample: '',
  });
  expect(parser?.id).toBe('tiaa-activity-csv');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiaa-activity-test-'));
  const filePath = path.join(dir, 'tiaa-retirement-annuity-2026.csv');
  await fs.writeFile(filePath, [
    'Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission',
    '01/05/2026,RET123,Contribution,TIAA Traditional,1.00,100,100.00,Employee contribution,,0',
  ].join('\n'));

  try {
    const result = await parser!.parse({
      fileName: path.basename(filePath),
      headers: ['Date', 'AccountId', 'Action', 'Security', 'Price', 'Quantity', 'Amount', 'Text', 'Memo', 'Commission'],
      rows: [],
      text: await fs.readFile(filePath, 'utf8'),
      filePath,
    });

    expect(result.transactions[0]).toMatchObject({
      sourceRowIndex: 0,
      date: '2026-01-05',
      amountCents: 10000,
      description: 'Contribution | TIAA Traditional',
      institution: 'TIAA',
      account: 'Retirement Annuity RET123',
      sourceRole: 'activity',
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
