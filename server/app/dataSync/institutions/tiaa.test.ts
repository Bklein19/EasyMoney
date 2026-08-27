import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Page } from 'playwright';

import { meta as tiaaStatementMeta } from '../../importParsers/moneyParsers/tiaa-statement-pdf.ts';
import {
  browserFetch,
  tiaaAuthenticationEntry,
  tiaaActivityAccountIds,
  tiaaActivityAccountTypes,
  tiaaActivityPeriod,
  tiaaActivityRemoteAccount,
  tiaaActivitySourceAccountName,
  tiaaResponseRequiresAuthentication,
  tiaaResponseBodyRequiresAuthentication,
  runAuthenticatedTiaa,
  tiaaSourceAccountClaimKey,
  tiaaStatementDocuments,
  tiaaStatementPeriod,
  tiaaStatementRequestUrl,
  validateTiaaActivityRequestBody,
  validateTiaaActivityArtifact,
  validateTiaaActivityCoverage,
  validateTiaaStatementDocumentIdentities,
  validateTiaaStatementArtifact,
} from './tiaa.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })
  ));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'easymoney-tiaa-test-'));
  temporaryDirectories.push(path);
  return path;
}

describe('TIAA live metadata mapping', () => {
  test('maps dynamically offered activity periods without assuming fixed years', () => {
    expect(tiaaActivityPeriod('Current year', '', 2026)).toEqual({
      label: 'Current year',
      value: '',
      year: 2026,
      coveredFrom: '2026-01-01',
      coveredThrough: '2026-12-31',
    });
    expect(tiaaActivityPeriod(' 2024 Years ', '', 2026)).toEqual({
      label: '2024 Years',
      value: '',
      year: 2024,
      coveredFrom: '2024-01-01',
      coveredThrough: '2024-12-31',
    });
    expect(tiaaActivityPeriod('Last 90 Days', '', 2026)).toBeNull();
  });

  test('accepts only the live-proven retirement activity selection', () => {
    expect(tiaaActivityAccountTypes({
      availableAccountTypes: [{ id: 'retirement', description: 'Retirement Accounts', selected: true }],
    })).toEqual([{
      id: 'retirement',
      description: 'Retirement Accounts',
      selected: true,
      routingKey: expect.stringMatching(/^[a-f0-9]{12}$/),
    }]);
    expect(() => tiaaActivityAccountTypes({
      availableAccountTypes: [
        { id: 'retirement', description: 'Retirement Accounts', selected: true },
        { id: 'trust', description: 'Trust Accounts', selected: false },
      ],
    })).toThrow('unsupported account selections');
    expect(() => tiaaActivityAccountTypes({
      availableAccountTypes: [{ id: 'trust', description: 'Trust Accounts', selected: true }],
    })).toThrow('unsupported account selections');
  });

  test('requires the captured request to preserve the selected period and account', () => {
    const period = tiaaActivityPeriod('Current year', '0', 2026)!;
    const account = { id: 'retirement', description: 'Retirement Accounts' };
    const request = {
      selectedTimePeriod: '0',
      selectedAccountTypes: [{ ...account, selected: true }],
      downloadCSV: true,
      noAccountSelected: false,
    };
    expect(validateTiaaActivityRequestBody(request, period, account)).toBe(request);
    expect(() => validateTiaaActivityRequestBody({ ...request, selectedTimePeriod: '1' }, period, account))
      .toThrow('did not match the selected period');
    expect(() => validateTiaaActivityRequestBody({
      ...request,
      selectedAccountTypes: [
        { ...account, selected: true },
        { id: 'trust', description: 'Trust Accounts', selected: true },
      ],
    }, period, account)).toThrow('did not isolate the supported account selection');
    expect(() => validateTiaaActivityRequestBody({ ...request, downloadCSV: false }, period, account))
      .toThrow('did not select an isolated CSV export');
    expect(() => validateTiaaActivityRequestBody({ ...request, noAccountSelected: true }, period, account))
      .toThrow('did not select an isolated CSV export');

    expect(() => validateTiaaActivityCoverage({
      coveredFrom: '2025-01-01',
      coveredThrough: '2025-12-31',
    }, period)).toThrow('outside the selected period');
  });

  test('maps quarterly periods from the live additionalDescription field', () => {
    expect(tiaaStatementPeriod('RETIREMENT Q2/2026')).toEqual({
      label: 'RETIREMENT Q2/2026',
      year: 2026,
      quarter: 2,
      coveredFrom: '2026-04-01',
      coveredThrough: '2026-06-30',
    });
    expect(tiaaStatementPeriod('Tax form 2026')).toBeNull();
  });

  test('discovers nested live statement documents and derives the direct report request', () => {
    const metadata = {
      success: true,
      data: {
        apiData: {
          categories: [{
            statements: [{
              additionalDescription: 'RETIREMENT Q2/2026',
              description: 'Quarterly Statements',
              docID: 'document-1',
              docLocation: 'location-1',
              docTypeID: 'document-type',
              categoryID: '100001',
              productType: 'retirement-account',
              destinationName: 'masked',
            }, {
              additionalDescription: 'RETIREMENT Q1/2026',
              description: 'Quarterly Statements',
              docID: 'document-2',
              docLocation: 'location-2',
              docTypeID: 'document-type',
              categoryID: '100001',
              productType: 'retirement-account',
              destinationName: 'masked',
            }],
          }],
        },
      },
    };
    const documents = tiaaStatementDocuments(metadata);
    expect(documents.map(document => document.label)).toEqual([
      'RETIREMENT Q2/2026',
      'RETIREMENT Q1/2026',
    ]);
    expect(new Set(documents.map(document => document.routingKey)).size).toBe(1);
    expect(() => validateTiaaStatementDocumentIdentities(documents)).not.toThrow();

    const url = new URL(tiaaStatementRequestUrl(documents[0]!));
    expect(url.pathname).toBe('/private/ahstatementsui/getreport');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      doc: 'document-1',
      linkName: 'RETIREMENT Q2/2026',
      categoryId: '100001',
      docType: 'document-type',
      docLoc: 'location-1',
      docProductType: 'retirement-account',
    });
  });

  test('rejects missing or ambiguous statement account identities', () => {
    const statement = {
      additionalDescription: 'RETIREMENT Q2/2026',
      description: 'Quarterly Statements',
      docID: 'document-1',
      docLocation: 'location-1',
      docTypeID: 'document-type',
      categoryID: '100001',
      productType: 'retirement-account',
      destinationName: '',
    };
    expect(() => tiaaStatementDocuments({ statements: [statement] }))
      .toThrow('missing a stable account identity');

    const documents = tiaaStatementDocuments({ statements: [
      { ...statement, destinationName: 'masked-one' },
      {
        ...statement,
        docID: 'document-2',
        docLocation: 'location-2',
        destinationName: 'masked-two',
      },
    ] });
    expect(() => validateTiaaStatementDocumentIdentities(documents))
      .toThrow('multiple accounts that the parser cannot distinguish');
  });
});

describe('TIAA parser claim identity', () => {
  test('uses the exact parser source-account key for connector routing', () => {
    expect(tiaaActivitySourceAccountName('RET123')).toBe('Retirement Annuity RET123');
    expect(tiaaSourceAccountClaimKey('Retirement Annuity RET123'))
      .toBe('TIAA||Retirement Annuity RET123');
    expect(tiaaActivityRemoteAccount('RET123')).toEqual({
      routingKey: expect.stringMatching(/^[a-f0-9]{12}$/),
      remoteAccountId: 'RET123',
      sourceAccountName: 'Retirement Annuity RET123',
      claimKey: 'TIAA||Retirement Annuity RET123',
    });
  });

  test('keeps direct authenticated requests and avoids fixed browser sleeps', async () => {
    const source = await Bun.file(resolve(import.meta.dir, 'tiaa.ts')).text();
    expect(source).toContain('/secure/participantdata/api/quickendownload');
    expect(source).toContain('/secure/account-statements/api/type');
    expect(source).toContain('/private/ahstatementsui/getreport');
    expect(source).toContain('fetch(destination');
    expect(source).not.toContain('normalizeHeadlessUserAgent');
    expect(source).toContain('--disable-blink-features=AutomationControlled');
    expect(source).not.toContain('normalChromeUserAgent');
    expect(source).not.toContain('chromium.launch');
    expect(source).not.toContain('page.context().request');
    expect(source).not.toContain('waitForTimeout(');
  });

  test('classifies authenticated request expiry for headed recovery', () => {
    expect(tiaaResponseRequiresAuthentication(401, 'https://my.tiaa.org/secure/account-statements/api/type'))
      .toBe(true);
    expect(tiaaResponseRequiresAuthentication(200, 'https://auth.tiaa.org/public/authentication/securelogin'))
      .toBe(true);
    expect(tiaaResponseRequiresAuthentication(200, 'https://my.tiaa.org/private/documentdelivery/documents/one'))
      .toBe(false);
    expect(tiaaResponseBodyRequiresAuthentication(
      'text/html',
      Buffer.from('<html><input type="password" autocomplete="current-password"></html>'),
    )).toBe(true);
    expect(tiaaResponseBodyRequiresAuthentication('text/html', Buffer.from('<html>Service unavailable</html>')))
      .toBe(false);
  });

  test('maps a CORS-failed login redirect request chain to authentication required', async () => {
    const destination = 'https://my.tiaa.org/secure/account-statements/api/type';
    const requestListeners: Array<(request: unknown) => void> = [];
    const rootRequest = {
      url: () => destination,
      method: () => 'GET',
      redirectedFrom: () => null,
    };
    const loginRequest = {
      url: () => 'https://auth.tiaa.org/public/authentication/securelogin',
      method: () => 'GET',
      redirectedFrom: () => rootRequest,
    };
    const page = {
      on(event: string, listener: (request: unknown) => void) {
        if (event === 'request') requestListeners.push(listener);
      },
      off(event: string, listener: (request: unknown) => void) {
        if (event !== 'request') return;
        const index = requestListeners.indexOf(listener);
        if (index >= 0) requestListeners.splice(index, 1);
      },
      async evaluate() {
        for (const listener of requestListeners) listener(loginRequest);
        throw new Error('Failed to fetch');
      },
    } as unknown as Page;

    await expect(browserFetch(page, destination)).rejects.toMatchObject({
      name: 'TiaaAuthenticationRequiredError',
    });

    const loginHtmlPage = {
      on() {},
      off() {},
      async evaluate() {
        return {
          status: 200,
          contentType: 'text/html',
          finalUrl: destination,
          body: Buffer.from('<html><input autocomplete="username"><input type="password"></html>')
            .toString('base64'),
        };
      },
    } as unknown as Page;
    await expect(browserFetch(loginHtmlPage, destination)).rejects.toMatchObject({
      name: 'TiaaAuthenticationRequiredError',
    });
  });
});

describe('TIAA artifact phase isolation', () => {
  test('uses statement readiness for statement-only browser sessions', () => {
    expect(tiaaAuthenticationEntry(['statement'])).toEqual({
      url: 'https://my.tiaa.org/secure/account-statements/all',
      ready: 'statement',
    });
    expect(tiaaAuthenticationEntry(['activity', 'statement'])).toEqual({
      url: 'https://my.tiaa.org/secure/participantdata/webconnect',
      ready: 'activity',
    });
  });

  test('statement-only discovery never depends on the activity SPA', async () => {
    let activityDiscoveryCalls = 0;
    let statementDiscoveryCalls = 0;
    const result = await runAuthenticatedTiaa({} as Page, {
      outputDir: '/tmp/tiaa-statement-only-test',
      from: '2026-07-01',
      through: '2026-08-24',
      artifactTypes: ['statement'],
    }, undefined, {
      discoverActivityMetadata: async () => {
        activityDiscoveryCalls += 1;
        throw new Error('activity discovery must not run');
      },
      discoverStatementDocuments: async () => {
        statementDiscoveryCalls += 1;
        return [];
      },
    });

    expect(activityDiscoveryCalls).toBe(0);
    expect(statementDiscoveryCalls).toBe(1);
    expect(result).toEqual({
      artifacts: [],
      accountsDiscovered: 0,
      accountSelectionsDiscovered: 0,
      activityPeriodsDiscovered: 0,
      statementsDiscovered: 0,
      emptyActivityExports: 0,
    });
  });

  test('does not count an account selection when every activity export is empty', async () => {
    const result = await runAuthenticatedTiaa({} as Page, {
      outputDir: '/tmp/tiaa-empty-activity-test',
      from: '2026-01-01',
      through: '2026-08-24',
      artifactTypes: ['activity'],
    }, undefined, {
      discoverActivityMetadata: async () => ({
        accountTypes: [{
          id: 'retirement',
          description: 'Retirement Accounts',
          selected: true,
          routingKey: 'aaaaaaaaaaaa',
        }],
        periods: [{
          label: 'Current year',
          value: '0',
          year: 2026,
          coveredFrom: '2026-01-01',
          coveredThrough: '2026-12-31',
        }],
      }),
      captureActivityRequestBody: async () => ({}),
      downloadActivityArtifact: async () => {
        throw new Error('TIAA CSV artifact contains no parser-visible activity');
      },
    });

    expect(result.accountsDiscovered).toBe(0);
    expect(result.accountSelectionsDiscovered).toBe(1);
    expect(result.emptyActivityExports).toBe(1);
  });
});

describe('TIAA parser-backed artifact validation', () => {
  test('validates every source-account claim in a consolidated activity export', async () => {
    const directory = await temporaryDirectory();
    const fileName = 'tiaa-retirement-annuity-2026-account-acde1234abcd-2026-01-01-to-2026-12-31.csv';
    const path = join(directory, fileName);
    const text = [
      'Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission',
      '01/05/2026,RET123,Contribution,TIAA Traditional,1.00,100,100.00,Employee contribution,,0',
      '01/06/2026,RET456,Contribution,CREF Stock,1.00,50,50.00,Employee contribution,,0',
    ].join('\n');
    await writeFile(path, text);

    expect(tiaaActivityAccountIds(text)).toEqual(['RET123', 'RET456']);
    await expect(validateTiaaActivityArtifact(path)).resolves.toEqual({
      size: Buffer.byteLength(text),
      remoteAccounts: [tiaaActivityRemoteAccount('RET123'), tiaaActivityRemoteAccount('RET456')],
      coveredFrom: '2026-01-05',
      coveredThrough: '2026-01-06',
      transactionCount: 2,
      balanceCount: 0,
    });
  });

  test('accepts stable hexadecimal routing keys in parser-recognized statement filenames', async () => {
    const directory = await temporaryDirectory();
    const fileName = 'tiaa-2026-06-30-retirement-q2-2026-acde1234abcd.pdf';
    const path = join(directory, fileName);
    const body = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(10_000, 0x20)]);
    await writeFile(path, body);

    expect(tiaaStatementMeta.matches({ filename: fileName, sample: '' })).toBe(true);
    await expect(validateTiaaStatementArtifact(path, fileName, async () => ({
      transactions: [{
        id: 'statement-transaction',
        date: '2026-06-30',
        amount_cents: 100,
        description: 'TIAA employee contribution',
        account: 'Retirement Annuity',
        institution: 'TIAA',
        category: 'statement-summary',
        raw: {},
      }],
      balances: [{
        date: '2026-06-30',
        account: 'Retirement Annuity',
        institution: 'TIAA',
        balance_cents: 123_45,
      }],
      covered_from: '2026-04-01',
      covered_to: '2026-06-30',
    }), {
      coveredFrom: '2026-04-01',
      coveredThrough: '2026-06-30',
    })).resolves.toEqual({
      size: body.length,
      remoteAccounts: [{
        routingKey: expect.stringMatching(/^[a-f0-9]{12}$/),
        remoteAccountId: 'Retirement Annuity',
        sourceAccountName: 'Retirement Annuity',
        claimKey: 'TIAA||Retirement Annuity',
      }],
      coveredFrom: '2026-04-01',
      coveredThrough: '2026-06-30',
      transactionCount: 1,
      balanceCount: 1,
    });

    await expect(validateTiaaStatementArtifact(path, fileName, async () => ({
      transactions: [],
      balances: [{
        date: '2026-06-30',
        account: 'Retirement Annuity',
        institution: 'TIAA',
        balance_cents: 123_45,
      }],
      covered_from: '2026-01-01',
      covered_to: '2026-03-31',
    }), {
      coveredFrom: '2026-04-01',
      coveredThrough: '2026-06-30',
    })).rejects.toThrow('coverage did not match');

    await expect(validateTiaaStatementArtifact(path, fileName, async () => ({
      transactions: [{
        id: 'unexpected-account',
        date: '2026-06-30',
        amount_cents: 100,
        description: 'Summary',
        account: 'Different TIAA Account',
        institution: 'TIAA',
        category: 'statement-summary',
        raw: {},
      }],
      balances: [{
        date: '2026-06-30',
        account: 'Retirement Annuity',
        institution: 'TIAA',
        balance_cents: 123_45,
      }],
      covered_from: '2026-04-01',
      covered_to: '2026-06-30',
    }), {
      coveredFrom: '2026-04-01',
      coveredThrough: '2026-06-30',
    })).rejects.toThrow('unexpected account identity');
  });
});
