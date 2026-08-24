import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sequoiaFundActivityParser } from '../../importParsers/sequoiaFundActivity.ts';
import {
  meta as sequoiaFundStatementMeta,
  sequoiaFundStatementAccount,
} from '../../importParsers/moneyParsers/sequoia-fund-pdf.ts';
import {
  parseSequoiaFundStatementList,
  selectAllSequoiaFundTransactions,
  selectSequoiaFundDuration,
  sequoiaFundAccountsFromOptions,
  sequoiaFundActivityRequest,
  selectSequoiaFundActivityExportForm,
  sequoiaFundStatementJobs,
  validateSequoiaFundArtifact,
  type SequoiaFundActivityForm,
  type SequoiaFundActivityFormCandidate,
} from './sequoiaFund.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function activityForm(
  action: string,
  method: SequoiaFundActivityForm['method'] = 'POST',
  enctype = 'application/x-www-form-urlencoded',
): SequoiaFundActivityForm {
  return {
    action,
    method,
    enctype,
    fields: {
      groupKey: 'fixture-group',
      securityID: 'fixture-security',
      acctNumber: 'fixture-account',
      startDate: '2026-01-01',
      endDate: '2026-08-23',
    },
  };
}

describe('Sequoia Fund account and request discovery', () => {
  test('discovers every account and deduplicates responsive copies without assuming a count', () => {
    const accounts = sequoiaFundAccountsFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
      { label: 'Investment account ending 2222', value: 'remote-b' },
      { label: 'Investment account ending 3333', value: 'remote-c' },
      { label: 'Investment account ending 1111', value: 'remote-a' },
    ]);

    expect(accounts.map(account => account.accountToken)).toEqual([
      'last4-1111',
      'last4-2222',
      'last4-3333',
    ]);
    expect(accounts.map(account => account.accountName)).toEqual([
      'Sequoia Fund - 1111',
      'Sequoia Fund - 2222',
      'Sequoia Fund - 3333',
    ]);
  });

  test('uses a stable opaque token when the site does not expose last four digits', () => {
    const first = sequoiaFundAccountsFromOptions([{ label: 'Investment account', value: 'opaque-account-a' }]);
    const second = sequoiaFundAccountsFromOptions([{ label: 'Investment account', value: 'opaque-account-a' }]);

    expect(first[0]?.accountToken).toMatch(/^key-[a-f0-9]{12}$/);
    expect(second[0]?.accountToken).toBe(first[0]?.accountToken);
  });

  test('rejects duplicate account identities instead of mixing artifacts', () => {
    expect(() => sequoiaFundAccountsFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
      { label: 'Second investment account ending 1111', value: 'remote-b' },
    ])).toThrow('ambiguous account identities');
  });

  test('chooses the smallest discovered duration that covers the requested range', () => {
    const options = [
      { label: 'Prior 30 days', value: '30d' },
      { label: 'Prior 3 months', value: '3m' },
      { label: 'Prior 12 months', value: '12m' },
      { label: 'All available history', value: 'all' },
    ];
    const today = new Date('2026-08-23T12:00:00Z');

    expect(selectSequoiaFundDuration(options, '2026-03-01', today).value).toBe('12m');
    expect(selectSequoiaFundDuration(options, '2020-01-01', today).value).toBe('all');
    expect(selectAllSequoiaFundTransactions([
      { label: 'Purchases', value: 'purchases' },
      { label: 'All transaction types', value: 'all-types' },
    ]).value).toBe('all-types');
  });

  test('selects the dynamically discovered export form instead of the visible filter form', () => {
    const candidates: SequoiaFundActivityFormCandidate[] = [
      {
        action: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory',
        method: 'GET',
        enctype: 'application/x-www-form-urlencoded',
        fields: { duration: '12m' },
        hints: ['transactionHistoryOptions'],
      },
      {
        action: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionHistoryCSV',
        method: 'POST',
        enctype: 'application/x-www-form-urlencoded',
        fields: { groupKey: 'fixture-group' },
        hints: ['port-history-csv'],
      },
      {
        action: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/posttaxltdetailsCSV',
        method: 'POST',
        enctype: 'application/x-www-form-urlencoded',
        fields: { securityID: 'fixture-security' },
        hints: ['taxlot-history-csv'],
      },
    ];

    expect(selectSequoiaFundActivityExportForm(
      candidates,
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory',
    )).toMatchObject({
      action: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionHistoryCSV',
      method: 'POST',
    });
  });

  test('encodes a dynamically discovered same-origin GET action as query parameters', () => {
    const request = sequoiaFundActivityRequest(
      activityForm(
        'https://secureaccountview.com/BFWeb/clients/sequoiafund/export-current-history?stale=ignored',
        'GET',
      ),
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory',
    );

    expect(request).toEqual({
      url: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/export-current-history?groupKey=fixture-group&securityID=fixture-security&acctNumber=fixture-account&startDate=2026-01-01&endDate=2026-08-23',
      method: 'GET',
      headers: { Referer: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory' },
    });
  });

  test('encodes a dynamically discovered same-origin POST action using its form encoding', () => {
    const request = sequoiaFundActivityRequest(
      activityForm('https://secureaccountview.com/BFWeb/clients/sequoiafund/export-current-history'),
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory',
    );

    expect(request).toEqual({
      url: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/export-current-history',
      method: 'POST',
      headers: { Referer: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory' },
      form: {
        groupKey: 'fixture-group',
        securityID: 'fixture-security',
        acctNumber: 'fixture-account',
        startDate: '2026-01-01',
        endDate: '2026-08-23',
      },
    });
    expect(() => sequoiaFundActivityRequest(
      activityForm('https://example.test/BFWeb/clients/sequoiafund/export'),
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory',
    )).toThrow('same-origin');
  });
});

describe('Sequoia Fund statement discovery', () => {
  test('expands every API document and maps each to one discovered account', () => {
    const accounts = sequoiaFundAccountsFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
      { label: 'Investment account ending 2222', value: 'remote-b' },
    ]);
    const list = parseSequoiaFundStatementList({
      success: true,
      data: {
        sessionId: 'fixture-session',
        statements: [
          {
            documentId: 'document-a',
            statementType: 'quarterly',
            statementDate: '2026-03-31',
            fundAccount: 'Account ending 1111',
          },
          {
            documentId: 'document-b',
            statementType: 'quarterly',
            statementDate: '06/30/2026',
            accountDescription: 'Account ending 2222',
          },
          {
            documentId: 'outside-range',
            statementType: 'quarterly',
            statementDate: '2025-12-31',
            fundAccount: 'Account ending 1111',
          },
        ],
      },
    });
    const jobs = sequoiaFundStatementJobs(
      accounts,
      list,
      { csrfToken: 'fixture-csrf', links: [] },
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/viewStatements',
      '2026-01-01',
      '2026-12-31',
    );

    expect(jobs).toHaveLength(2);
    expect(jobs.map(job => job.account.accountToken).sort()).toEqual(['last4-1111', 'last4-2222']);
    expect(jobs.every(job => job.request.method === 'GET')).toBe(true);
    expect(jobs.every(job => job.request.url.startsWith(
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/statements/',
    ))).toBe(true);
    expect(jobs.every(job => /^sequoia-fund-account-last4-\d{4}-\d{4}-\d{2}-\d{2}-statement-[a-f0-9]{10}\.pdf$/.test(
      job.fileName,
    ))).toBe(true);
  });

  test('rejects statement metadata that cannot distinguish multiple accounts', () => {
    const accounts = sequoiaFundAccountsFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
      { label: 'Investment account ending 2222', value: 'remote-b' },
    ]);
    const list = parseSequoiaFundStatementList({
      success: true,
      data: {
        sessionId: 'fixture-session',
        statements: [{
          documentId: 'document-a',
          statementType: 'quarterly',
          statementDate: '2026-03-31',
        }],
      },
    });

    expect(() => sequoiaFundStatementJobs(
      accounts,
      list,
      { csrfToken: 'fixture-csrf', links: [] },
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/viewStatements',
      '2026-01-01',
      '2026-12-31',
    )).toThrow('account mapping is ambiguous');
  });
});

describe('Sequoia Fund parser validation', () => {
  test('activity artifacts carry account identity through the matching parser', async () => {
    const directory = await mkdtemp('/private/tmp/easymoney-sequoia-test-');
    temporaryDirectories.push(directory);
    const account = sequoiaFundAccountsFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
    ])[0]!;
    const fileName = 'sequoia-fund-account-last4-1111-activity-2026-01-01-to-2026-08-23.csv';
    const path = join(directory, fileName);
    await writeFile(path, [
      'Transaction Date,Transaction Type,Description,Dollar Amount',
      '08/01/2026,Fund Purchase,Electronic contribution,"$400.00"',
      '08/02/2026,Withdrawal,Distribution,"$25.00"',
    ].join('\n'));

    const validated = await validateSequoiaFundArtifact(path, 'activity', account);
    expect(validated).toMatchObject({
      parserId: 'sequoia-fund-activity-csv',
      accountToken: 'last4-1111',
      accountName: 'Sequoia Fund - 1111',
      transactionCount: 2,
      balanceCount: 0,
    });

    const parsed = await sequoiaFundActivityParser.parse({
      fileName,
      headers: [],
      rows: [],
      text: await Bun.file(path).text(),
      filePath: path,
    });
    expect(parsed.transactions[0]).toMatchObject({ amountCents: 40_000, account: 'Sequoia Fund - 1111' });
    expect(parsed.transactions[1]).toMatchObject({ amountCents: -2_500, account: 'Sequoia Fund - 1111' });
  });

  test('rejects HTML masquerading as an activity artifact before parser success', async () => {
    const directory = await mkdtemp('/private/tmp/easymoney-sequoia-test-');
    temporaryDirectories.push(directory);
    const account = sequoiaFundAccountsFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
    ])[0]!;
    const path = join(
      directory,
      'sequoia-fund-account-last4-1111-activity-2026-01-01-to-2026-08-23.csv',
    );
    await writeFile(path, '<html>,authentication required\nnot financial data');

    await expect(validateSequoiaFundArtifact(path, 'activity', account)).rejects.toThrow('signature is invalid');
  });

  test('statement parser accepts account-identifiable names and checks visible last four digits', () => {
    const fileName = 'sequoia-fund-account-last4-1111-2026-06-30-statement-a1b2c3d4e5.pdf';
    expect(sequoiaFundStatementMeta.matches({ filename: fileName, sample: '' })).toBe(true);
    expect(sequoiaFundStatementAccount(fileName, 'Fund account number: XXXX1111')).toBe('Sequoia Fund - 1111');
    expect(() => sequoiaFundStatementAccount(
      fileName,
      'Fund account number: XXXX2222',
    )).toThrow('does not match its artifact identity');
  });
});

test('Sequoia Fund institution code uses direct requests and no fixed browser waits', async () => {
  const source = await Bun.file(new URL('./sequoiaFund.ts', import.meta.url)).text();

  expect(source).toContain('page.context().request');
  expect(source).toContain("savedAuthenticationMode: 'headed'");
  expect(source).not.toContain('waitForTimeout');
  expect(source).not.toContain("waitForEvent('download'");
});
