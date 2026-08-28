import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sequoiaFundActivityParser } from '../../importParsers/sequoiaFundActivity.ts';
import {
  meta as sequoiaFundStatementMeta,
  sequoiaFundStatementAccount,
} from '../../importParsers/moneyParsers/sequoia-fund-pdf.ts';
import {
  classifySequoiaFundArtifactBytes,
  parseSequoiaFundStatementList,
  safeSequoiaFundErrorMessage,
  sequoiaFundBrowserSession,
  sequoiaFundCanonicalAccount,
  sequoiaFundStatementJobs,
  sequoiaFundStatementListRequest,
  validateSequoiaFundArtifact,
} from './sequoiaFund.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })
  ));
});

describe('Sequoia Fund canonical account', () => {
  test('uses the selected local account identity independently of remote portfolio fields', () => {
    expect(sequoiaFundCanonicalAccount('last4-1111')).toEqual({
      accountToken: 'last4-1111',
      accountName: 'Sequoia Fund - 1111',
    });
    expect(sequoiaFundCanonicalAccount('key-abc123abc123')).toEqual({
      accountToken: 'key-abc123abc123',
      accountName: 'Sequoia Fund account abc123abc123',
    });
    expect(() => sequoiaFundCanonicalAccount('remote-account')).toThrow(
      'canonical account token is invalid',
    );
  });
});

describe('Sequoia Fund statement discovery', () => {
  test('posts the statement-list query with the page CSRF state', () => {
    expect(sequoiaFundStatementListRequest({
      csrfToken: 'opaque-csrf',
      referer: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/viewStatements',
    })).toEqual({
      url: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/statements/getStatementList?csrf_token=opaque-csrf',
      method: 'POST',
      form: { queryType: 'all' },
      headers: {
        Referer: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/viewStatements',
      },
    });
  });

  test('expands every API document under the canonical login-level account', () => {
    const account = sequoiaFundCanonicalAccount('last4-1111');
    const list = parseSequoiaFundStatementList({
      success: true,
      data: {
        sessionId: 'fixture-session',
        statements: [
          {
            documentId: 'document-a',
            statementDate: '2026-03-31',
            fundAccount: 'Account ending 1111',
          },
          {
            documentId: 'document-b',
            statementType: 'ignored-by-the-site',
            statementDate: '06/30/2026',
            accountDescription: 'Account ending 2222',
          },
          {
            documentId: 'outside-range',
            statementDate: '2025-12-31',
            fundAccount: 'Account ending 1111',
          },
        ],
      },
    });
    const jobs = sequoiaFundStatementJobs(
      account,
      list,
      {
        csrfToken: 'fixture-csrf',
        referer: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/viewStatements',
      },
      '2026-01-01',
      '2026-12-31',
    );

    expect(jobs).toHaveLength(2);
    expect(jobs.every(job => job.account.accountToken === 'last4-1111')).toBe(true);
    expect(jobs.every(job => job.request.method === 'GET')).toBe(true);
    expect(jobs.every(job => job.request.url.startsWith(
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/statements/',
    ))).toBe(true);
    expect(jobs.map(job => job.request.url)).toEqual([
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/statements/document-a/pdf/fixture-session?csrf_token=fixture-csrf',
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/statements/document-b/pdf/fixture-session?csrf_token=fixture-csrf',
    ]);
    expect(jobs.every(job =>
      /^sequoia-fund-account-last4-\d{4}-\d{4}-\d{2}-\d{2}-statement-[a-f0-9]{10}\.pdf$/.test(
        job.fileName,
      )
    )).toBe(true);
  });

  test('rejects statement documents without complete direct-download state', () => {
    const account = sequoiaFundCanonicalAccount('last4-1111');
    const list = parseSequoiaFundStatementList({
      success: true,
      data: {
        sessionId: 'fixture-session',
        statements: [{
          documentId: 'document-a',
          statementDate: '2026-03-31',
        }],
      },
    });

    expect(() => sequoiaFundStatementJobs(
      account,
      list,
      {
        csrfToken: '',
        referer: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/viewStatements',
      },
      '2026-01-01',
      '2026-12-31',
    )).toThrow('download metadata is unavailable');
  });
});

describe('Sequoia Fund parser validation', () => {
  test('redacts discovered server values from errors', () => {
    const sensitiveValue = 'opaqueValue-9qZ';
    const message = safeSequoiaFundErrorMessage(
      new Error('request failed for ' + sensitiveValue + ' at https://secureaccountview.com/private'),
      [sensitiveValue],
    );

    expect(message).toContain('<redacted-selection>');
    expect(message).toContain('<redacted-url>');
    expect(message).not.toContain(sensitiveValue);
    expect(message).not.toContain('secureaccountview.com');
  });

  test('classifies parser-safe and rejected artifact byte signatures without exposing content', () => {
    expect(classifySequoiaFundArtifactBytes(new Uint8Array())).toBe('empty');
    expect(classifySequoiaFundArtifactBytes(Buffer.from('%PDF-1.7 fixture'))).toBe('pdf');
    expect(classifySequoiaFundArtifactBytes(Buffer.from('<html>login</html>'))).toBe('html');
    expect(classifySequoiaFundArtifactBytes(Buffer.from('{"error":true}'))).toBe('json');
    expect(classifySequoiaFundArtifactBytes(
      Buffer.from('Date,Amount\n01/01/2026,1.00'),
    )).toBe('csv');
    expect(classifySequoiaFundArtifactBytes(
      Buffer.from('Date\tAmount\n01/01/2026\t1.00'),
    )).toBe('tabular-text');
    expect(classifySequoiaFundArtifactBytes(
      Uint8Array.from([65, 0, 66, 0]),
    )).toBe('utf16-or-binary');
    expect(classifySequoiaFundArtifactBytes(Buffer.from('plain text'))).toBe('text');
  });

  test('activity artifacts carry account identity through the matching parser', async () => {
    const directory = await mkdtemp('/private/tmp/easymoney-sequoia-test-');
    temporaryDirectories.push(directory);
    const account = sequoiaFundCanonicalAccount('last4-1111');
    const fileName =
      'sequoia-fund-account-last4-1111-activity-2026-01-01-to-2026-08-23.csv';
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
    expect(parsed.transactions[0]).toMatchObject({
      amountCents: 40_000,
      account: 'Sequoia Fund - 1111',
    });
    expect(parsed.transactions[1]).toMatchObject({
      amountCents: -2_500,
      account: 'Sequoia Fund - 1111',
    });
  });

  test('rejects HTML masquerading as an activity artifact before parser success', async () => {
    const directory = await mkdtemp('/private/tmp/easymoney-sequoia-test-');
    temporaryDirectories.push(directory);
    const account = sequoiaFundCanonicalAccount('last4-1111');
    const path = join(
      directory,
      'sequoia-fund-account-last4-1111-activity-2026-01-01-to-2026-08-23.csv',
    );
    await writeFile(path, '<html>,authentication required\nnot financial data');

    await expect(validateSequoiaFundArtifact(path, 'activity', account)).rejects.toThrow(
      'signature is invalid',
    );
  });

  test('statement parser accepts account-identifiable names and checks visible last four digits', () => {
    const fileName =
      'sequoia-fund-account-last4-1111-2026-06-30-statement-a1b2c3d4e5.pdf';
    expect(sequoiaFundStatementMeta.matches({ filename: fileName, sample: '' })).toBe(true);
    expect(sequoiaFundStatementAccount(
      fileName,
      'Fund account number: XXXX1111',
    )).toBe('Sequoia Fund - 1111');
    expect(() => sequoiaFundStatementAccount(
      fileName,
      'Fund account number: XXXX2222',
    )).toThrow('does not match its artifact identity');
  });
});

test('Sequoia Fund uses direct authenticated HTTP after login', async () => {
  const source = await Bun.file(new URL('./sequoiaFund.ts', import.meta.url)).text();

  expect(source).toContain('runAuthenticatedHttpRequest(page');
  expect(source).toContain('parseSequoiaFundPortfolio');
  expect(source).toContain('sequoiaFundActivityExportFields');
  expect(source).not.toContain('runBrowserNativeRequest(page');
  expect(source).not.toContain('page.context().request');
  expect(source).not.toContain('page.waitForRequest');
  expect(source).not.toContain('page.goto(');
  expect(source).not.toContain('page.locator(');
  expect(source).not.toContain('page.waitForFunction(');
  expect(source).not.toContain('locator.selectOption');
  expect(source).not.toContain('requestSubmit');
  expect(source).not.toContain("page.waitForEvent('download'");
  expect(source).not.toContain('waitForTimeout');
});

test('Sequoia Fund always starts headed without reading or writing saved authentication', async () => {
  expect(sequoiaFundBrowserSession(
    'sequoia-fund-catchup',
    '/private/tmp/fixture-profile',
  )).toEqual({
    name: 'sequoia-fund-catchup',
    startUrl: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/index',
    profilePath: '/private/tmp/fixture-profile',
    persistAuthentication: false,
    contextOptions: { headless: false },
  });

  const source = await Bun.file(new URL('./sequoiaFund.ts', import.meta.url)).text();
  expect(source).not.toContain('playwrightHasSavedAuthentication');
  expect(source).toContain('cachedAuthentication: false');
});
