import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

import {
  playwrightAuthStatePath,
  playwrightSessionStoragePath,
} from '../browserSession.ts';

import {
  assertVanguardArtifactAccount,
  createVanguardProgress,
  discoverVanguardAccounts,
  isVanguardAuthenticatedPage,
  isVanguardAuthenticatedPath,
  mapVanguardRemoteAccounts,
  parseVanguardAccountApiResponse,
  parseVanguardStatementApiResponse,
  runVanguardProfilesConcurrently,
  safeVanguardError,
  transitionVanguardToInteractiveAuthentication,
  VANGUARD_AUTHENTICATION_TIMEOUT_MS,
  validateVanguardArtifact,
  vanguardApiResponseRequiresAuthentication,
  vanguardActivityApiRequest,
  vanguardBrowserFetchInPage,
  vanguardActivityCsvFromEnvelope,
  vanguardAuthenticationAction,
  vanguardAccountLast4FromText,
  vanguardCsvAccountLast4s,
  vanguardStatementAccountRoutes,
  vanguardStatementListRequest,
  vanguardStatementPdfRequest,
  vanguardThroughDate,
  type VanguardAccountApiRecord,
  type VanguardSyncAccount,
  type VanguardProgressEvent,
} from './vanguard.ts';

test('Vanguard interactive authentication allows a full user MFA window', () => {
  expect(VANGUARD_AUTHENTICATION_TIMEOUT_MS).toBe(30 * 60_000);
});

function apiAccount(
  last4: string,
  accountName: string,
  nickname: string,
  productType = 'BROKERAGE',
): VanguardAccountApiRecord {
  return {
    accountId: `account-${last4}`,
    accountName,
    balance: '0.00',
    fundAccountNumber: `0000${last4}`,
    fundName: '',
    isManaged: false,
    nickname,
    productType,
  };
}

test('Vanguard authentication requires a signed-in portfolio route', () => {
  expect(isVanguardAuthenticatedPath('/en/investor/portfolio/dashboard/')).toBe(true);
  expect(isVanguardAuthenticatedPath('/en/investor/portfolio/transactions/history')).toBe(true);
  expect(isVanguardAuthenticatedPath('/my-account/log-on')).toBe(false);
  expect(isVanguardAuthenticatedPath('/')).toBe(false);
});

test('Vanguard authentication recognizes the signed-in download center', async () => {
  const page = {
    url: () => 'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofx-welcome',
    locator: () => ({ count: async () => 0 }),
    getByRole: () => ({ count: async () => 1 }),
  } as unknown as Page;

  expect(await isVanguardAuthenticatedPage(page)).toBe(true);
});

test('Vanguard API redirects to login require interactive authentication', () => {
  const response = (
    status: number,
    url: string,
    location?: string,
  ) => ({
    status,
    url,
    headers: (location ? { location } : {}) as Record<string, string>,
    redirected: false,
  });

  expect(vanguardApiResponseRequiresAuthentication(response(
    302,
    'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofu-accounts',
    'https://logon.vanguard.com/logon',
  ))).toBe(true);
  expect(vanguardApiResponseRequiresAuthentication(response(
    302,
    'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofu-accounts',
    'https://investor.vanguard.com/my-account/log-on',
  ))).toBe(true);
  expect(vanguardApiResponseRequiresAuthentication(response(
    302,
    'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofu-accounts',
  ))).toBe(true);
  expect(vanguardApiResponseRequiresAuthentication(response(
    200,
    'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofu-accounts',
  ))).toBe(false);
  expect(vanguardApiResponseRequiresAuthentication({
    status: 0,
    url: 'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofu-accounts',
    headers: {},
    redirected: true,
  })).toBe(true);
});

test('Vanguard browser transport handles a relative redirect and response cookie in Chromium', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/api') {
        return new Response(null, {
          status: 302,
          headers: {
            location: '/login',
            'set-cookie': 'fixture-session=rotated; Path=/; SameSite=Lax',
          },
        });
      }
      if (url.pathname === '/binary') {
        const validRequest = request.method === 'POST' &&
          request.headers.get('x-fixture-request') === 'preserved' &&
          request.headers.get('cookie')?.includes('fixture-session=rotated') &&
          await request.text() === '{"request":"body"}';
        return new Response(validRequest ? Uint8Array.from([0, 1, 254, 255]) : 'invalid request', {
          status: validRequest ? 200 : 400,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      return new Response('<!doctype html><title>Fixture</title>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const page = await browser.newPage();
    await page.goto(`${origin}/app`);
    const fixtureRequest = {
      url: `${origin}/api`,
      method: 'GET',
    } as const;
    const response = await page.evaluate(vanguardBrowserFetchInPage, fixtureRequest);

    expect(response.status).toBe(0);
    expect(response.redirected).toBe(true);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await page.evaluate(() => document.cookie.includes('fixture-session=rotated'))).toBe(true);

    const binaryResponse = await page.evaluate(vanguardBrowserFetchInPage, {
      url: `${origin}/binary`,
      method: 'POST',
      body: '{"request":"body"}',
      headers: {
        'content-type': 'application/json',
        'x-fixture-request': 'preserved',
      },
    } as const);
    expect(binaryResponse.status).toBe(200);
    expect(binaryResponse.url).toBe(`${origin}/binary`);
    expect(binaryResponse.headers['content-type']).toBe('application/octet-stream');
    expect([...Buffer.from(binaryResponse.bodyBase64, 'base64')]).toEqual([0, 1, 254, 255]);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 20_000);

test('Vanguard account discovery moves browser fetch onto the authenticated API application origin', async () => {
  let url = 'https://investor.vanguard.com/en/investor/portfolio/dashboard';
  const navigations: string[] = [];
  const requests: unknown[] = [];
  const body = JSON.stringify({
    accounts: [apiAccount('1111', 'Brokerage account', 'Individual brokerage')],
  });
  const page = {
    url: () => url,
    isClosed: () => false,
    goto: async (nextUrl: string) => {
      navigations.push(nextUrl);
      url = nextUrl;
      return null;
    },
    evaluate: async (_operation: unknown, request: unknown) => {
      requests.push(request);
      return {
        status: 200,
        url: 'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofu-accounts',
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from(body).toString('base64'),
        redirected: false,
      };
    },
  } as unknown as Page;

  const accounts = await discoverVanguardAccounts(page);

  expect(navigations).toEqual([
    'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofx-welcome',
  ]);
  expect(requests).toEqual([{
    url: 'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofu-accounts',
    method: 'GET',
  }]);
  expect(accounts.map(account => account.accountLast4)).toEqual(['1111']);
});

test('Vanguard expired API auth leaves stale portfolio UI for a genuine sign-in page', async () => {
  const profilePath = await mkdtemp(join(tmpdir(), 'vanguard-expired-auth-'));
  const authStatePath = playwrightAuthStatePath(profilePath);
  const sessionStoragePath = playwrightSessionStoragePath(profilePath);
  await writeFile(authStatePath, '{"cookies":[]}');
  await writeFile(sessionStoragePath, '{}');

  let url = 'https://investor.vanguard.com/en/investor/portfolio/dashboard';
  let authenticationFields = false;
  const calls: string[] = [];
  const page = {
    url: () => url,
    locator: () => ({ count: async () => authenticationFields ? 1 : 0 }),
    getByRole: () => ({ count: async () => url.includes('/portfolio/') ? 1 : 0 }),
    context: () => ({
      clearCookies: async () => { calls.push('clear-cookies'); },
    }),
    evaluate: async () => { calls.push('clear-storage'); },
    goto: async (nextUrl: string, options: unknown) => {
      calls.push(`goto:${nextUrl}:${JSON.stringify(options)}`);
      url = 'https://logon.vanguard.com/logon';
      authenticationFields = true;
      return null;
    },
  } as unknown as Page;

  try {
    expect(await isVanguardAuthenticatedPage(page)).toBe(true);
    const result = await transitionVanguardToInteractiveAuthentication(page, {
      session: 'vanguard-catchup',
      accountHolder: 'Example One',
      profilePath,
    });

    expect(result).toEqual({
      status: 'login-required',
      action: 'Sign in to Vanguard for Example One and complete MFA. EasyMoney will continue automatically.',
    });
    expect(calls).toEqual([
      'clear-cookies',
      'clear-storage',
      'goto:https://investor.vanguard.com/my-account/log-on:{"waitUntil":"domcontentloaded"}',
    ]);
    expect(await isVanguardAuthenticatedPage(page)).toBe(false);
    expect(await stat(authStatePath).catch(() => null)).toBeNull();
    expect(await stat(sessionStoragePath).catch(() => null)).toBeNull();
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});

test('Vanguard diagnostics discard request call logs and secrets', () => {
  const message = [
    'Timeout 30000ms exceeded.',
    'Call log:',
    '- cookie: session=private-token',
    '- authorization: Bearer private-token',
  ].join('\n');

  expect(safeVanguardError(new Error(message))).toBe('Vanguard request timed out');
  expect(safeVanguardError(new Error('cookie: session=private-token'))).toBe(
    'Vanguard request failed',
  );
});

test('Vanguard authentication copy identifies the intended account holder', () => {
  expect(vanguardAuthenticationAction({ accountHolder: 'Example One' })).toBe(
    'Sign in to Vanguard for Example One and complete MFA. EasyMoney will continue automatically.',
  );
  expect(() => vanguardAuthenticationAction({ accountHolder: '   ' })).toThrow(
    'require an account holder',
  );
});

test('Vanguard progress records profile identity and elapsed dependency time', () => {
  const events: VanguardProgressEvent[] = [];
  let now = 100;
  const progress = createVanguardProgress(
    event => events.push(event),
    'current',
    () => now,
    () => '2026-08-24T00:00:00.000Z',
  );

  progress('activity', 'activity-download', 'start', 'Downloading activity');
  now = 142;
  progress('activity', 'activity-download', 'complete', 'Validated activity', {
    parserValidated: true,
  });

  expect(events).toEqual([
    {
      profileId: 'current',
      phase: 'activity-download',
      state: 'start',
      timestamp: '2026-08-24T00:00:00.000Z',
      message: 'Downloading activity',
    },
    {
      profileId: 'current',
      phase: 'activity-download',
      state: 'complete',
      timestamp: '2026-08-24T00:00:00.000Z',
      message: 'Validated activity',
      elapsedMs: 42,
      data: { parserValidated: true },
    },
  ]);
});

test('Vanguard caps UTC-tomorrow downloads to the local calendar date', () => {
  const lateEvening = new Date(2026, 7, 18, 23, 30);

  expect(vanguardThroughDate('2026-08-19', lateEvening)).toBe('2026-08-18');
  expect(vanguardThroughDate('2026-07-01', lateEvening)).toBe('2026-07-01');
});

test('Vanguard artifacts must match the planned account before import', () => {
  const csv = [
    'Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,',
    '00001111,EXAMPLE FUND,VTI,1,100,100,',
    '',
    'Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type,',
    '00001111,2026-07-16,2026-07-16,Funds Received,Electronic Bank Transfer,CASH,,0,0,400.00,0,400.00,0,CASH,',
  ].join('\n');

  expect(vanguardCsvAccountLast4s(csv)).toEqual(['1111']);
  expect(() => assertVanguardArtifactAccount('1111', ['1111'])).not.toThrow();
  expect(() => assertVanguardArtifactAccount(['1111', '2222'], ['2222'])).not.toThrow();
  expect(() => assertVanguardArtifactAccount('2222', ['1111'])).toThrow('does not match');
  expect(() => assertVanguardArtifactAccount('1111', ['1111', '2222'])).toThrow('does not match');
});

test('Vanguard extracts account identity from statement text without confusing dates', () => {
  expect(vanguardAccountLast4FromText(
    'Individual brokerage account XXXX1111 statement date 07/31/2026',
  )).toBe('1111');
  expect(vanguardAccountLast4FromText('Roth IRA brokerage account ending in 2222')).toBe('2222');
  expect(vanguardAccountLast4FromText('Statement date 07/31/2026')).toBeNull();
});

test('Vanguard starts independent cached profiles concurrently', async () => {
  const profiles = [
    { id: 'first', session: 'vanguard-first', accountHolder: 'Example One', accounts: [] },
    { id: 'second', session: 'vanguard-second', accountHolder: 'Example Two', accounts: [] },
  ];
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const running = runVanguardProfilesConcurrently(profiles, profile => new Promise<string>(resolve => {
    started.push(profile.id);
    releases.set(profile.id, () => resolve(profile.id));
  }));

  await Promise.resolve();
  expect(started).toEqual(['first', 'second']);
  releases.get('first')!();
  releases.get('second')!();
  expect(await running).toEqual(['first', 'second']);
});

test('Vanguard maps every remote account to exactly one local route in remote order', () => {
  const planned: VanguardSyncAccount[] = [
    {
      accountId: 10,
      accountKind: 'brokerage',
      accountLast4: '1111',
      startDate: '2026-01-01',
      statementDates: [],
    },
    {
      accountId: 20,
      accountKind: 'roth-ira',
      accountLast4: '2222',
      startDate: '2026-02-01',
      statementDates: [],
    },
    {
      accountId: 30,
      accountKind: 'traditional-ira',
      accountLast4: '3333',
      startDate: '2026-03-01',
      statementDates: [],
    },
  ];
  const remote = parseVanguardAccountApiResponse({ accounts: [
    apiAccount('3333', 'Traditional IRA', 'Rollover IRA'),
    apiAccount('1111', 'Individual brokerage', 'Brokerage'),
    apiAccount('2222', 'Roth IRA', 'Roth IRA'),
  ] });

  expect(mapVanguardRemoteAccounts(remote, planned).map(account => account.planned.accountId)).toEqual([30, 10, 20]);
});

test('Vanguard discovers any number of API accounts without relying on browser controls', () => {
  const accounts = parseVanguardAccountApiResponse({
    accounts: [
      apiAccount('1111', 'Individual brokerage Sample Owner', 'Brokerage'),
      apiAccount('2222', 'Roth IRA Sample Owner', 'Roth IRA'),
      apiAccount('3333', 'Rollover IRA Sample Owner', 'Rollover IRA'),
      apiAccount('4444', 'Joint brokerage Sample Household', 'Joint brokerage'),
    ],
  });

  expect(accounts.map(account => ({
    accountKind: account.accountKind,
    accountLast4: account.accountLast4,
    accountId: account.apiAccount.accountId,
  }))).toEqual([
    { accountKind: 'brokerage', accountLast4: '1111', accountId: 'account-1111' },
    { accountKind: 'roth-ira', accountLast4: '2222', accountId: 'account-2222' },
    { accountKind: 'traditional-ira', accountLast4: '3333', accountId: 'account-3333' },
    { accountKind: 'brokerage', accountLast4: '4444', accountId: 'account-4444' },
  ]);
});

test('Vanguard account API routing rejects invalid and ambiguous identities', () => {
  expect(() => parseVanguardAccountApiResponse({ accounts: [{
    accountId: 'missing-number',
    accountName: 'Brokerage without number',
    fundAccountNumber: '',
  }] })).toThrow('no usable identity');

  expect(() => parseVanguardAccountApiResponse({ accounts: [
    apiAccount('1111', 'Individual brokerage A', 'First'),
    apiAccount('1111', 'Individual brokerage B', 'Second'),
  ] })).toThrow('ambiguous account identities');
});

test('Vanguard uses only a unique kind fallback and rejects ambiguous account routes', () => {
  const planned: VanguardSyncAccount[] = [{
    accountId: 10,
    accountKind: 'brokerage',
    accountLast4: '1111',
    startDate: '2026-01-01',
    statementDates: [],
  }];

  expect(mapVanguardRemoteAccounts([
    ...parseVanguardAccountApiResponse({
      accounts: [apiAccount('2222', 'Individual brokerage', 'Brokerage')],
    }),
  ], planned).map(account => account.planned.accountId)).toEqual([10]);
  expect(() => mapVanguardRemoteAccounts(
    parseVanguardAccountApiResponse({
      accounts: [apiAccount('1111', 'Roth IRA', 'Roth IRA')],
    }),
    planned,
  )).toThrow('conflicts with its planned local account kind');
  expect(() => mapVanguardRemoteAccounts([
    {
      ...parseVanguardAccountApiResponse({
        accounts: [apiAccount('1111', 'Individual brokerage', 'Brokerage')],
      })[0]!,
    },
    {
      ...parseVanguardAccountApiResponse({
        accounts: [apiAccount('2222', 'Individual brokerage', 'Brokerage')],
      })[0]!,
      accountLast4: '1111',
    },
  ], planned)).toThrow('ambiguous remote account identities');

  const twoBrokerages: VanguardSyncAccount[] = [
    planned[0]!,
    { ...planned[0]!, accountId: 20, accountLast4: '3333' },
  ];
  expect(() => mapVanguardRemoteAccounts(
    parseVanguardAccountApiResponse({ accounts: [
      apiAccount('2222', 'Individual brokerage A', 'Brokerage A'),
      apiAccount('4444', 'Individual brokerage B', 'Brokerage B'),
    ] }),
    twoBrokerages,
  )).toThrow('no unambiguous local account route');
});

test('Vanguard allows a planned dormant account to be absent from activity downloads', () => {
  const planned: VanguardSyncAccount[] = [
    {
      accountId: 10,
      accountKind: 'brokerage',
      accountLast4: '1111',
      startDate: '2026-01-01',
      statementDates: [],
    },
    {
      accountId: 20,
      accountKind: 'traditional-ira',
      accountLast4: '2222',
      startDate: '2026-01-01',
      statementDates: [],
    },
  ];

  expect(mapVanguardRemoteAccounts([
    ...parseVanguardAccountApiResponse({
      accounts: [apiAccount('1111', 'Individual brokerage', 'Brokerage')],
    }),
  ], planned).map(account => account.planned.accountId)).toEqual([10]);
});

test('Vanguard carries a safely matched remote identity into statement routing', () => {
  const planned: VanguardSyncAccount[] = [{
    accountId: 10,
    accountKind: 'brokerage',
    accountLast4: '1111',
    startDate: '2026-01-01',
    statementDates: ['2026-07-31'],
  }];
  const mapped = mapVanguardRemoteAccounts(
    parseVanguardAccountApiResponse({
      accounts: [apiAccount('9999', 'Individual brokerage', 'Brokerage')],
    }),
    planned,
  );
  const routes = vanguardStatementAccountRoutes(planned, mapped);

  expect(routes).toEqual([{
    account: planned[0],
    identityLast4s: ['1111', '9999'],
  }]);
  expect(parseVanguardStatementApiResponse({ statements: [{
    endDate: '2026-07-31',
    statementDescription: 'Individual brokerage XXXX9999',
    statementId: 'statement-document',
  }] }, routes)[0]).toMatchObject({
    accountKind: 'brokerage',
    accountLast4: '1111',
    validationAccountLast4s: ['1111', '9999'],
  });
});

test('Vanguard builds direct statement list and PDF requests', () => {
  expect(vanguardStatementListRequest('2026')).toEqual({
    url: 'https://personal1.vanguard.com/usa/api/lah-statements-consumer/statements/consumer?year=2026',
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: 'https://statements.web.vanguard.com/',
      urlflag: 'getStatements',
    },
  });
  expect(vanguardStatementPdfRequest('example-statement-id')).toEqual({
    url: 'https://personal1.vanguard.com/usa/api/lah-statements-consumer/statements/pdf',
    method: 'GET',
    headers: {
      accept: 'application/pdf, */*',
      referer: 'https://statements.web.vanguard.com/',
      statementid: 'example-statement-id',
      urlflag: 'getPdf',
    },
  });
  expect(() => vanguardStatementListRequest('26')).toThrow('must use YYYY');
  expect(() => vanguardStatementPdfRequest('')).toThrow('document identity');
});

test('Vanguard routes statement API records to planned accounts without guessing', () => {
  const planned: VanguardSyncAccount[] = [
    {
      accountId: 10,
      accountKind: 'brokerage',
      accountLast4: '1111',
      startDate: '2026-01-01',
      statementDates: [],
    },
    {
      accountId: 20,
      accountKind: 'roth-ira',
      accountLast4: '2222',
      startDate: '2026-01-01',
      statementDates: [],
    },
    {
      accountId: 30,
      accountKind: 'traditional-ira',
      accountLast4: '3333',
      startDate: '2026-01-01',
      statementDates: [],
    },
  ];
  const routes = planned.map(account => ({ account, identityLast4s: [account.accountLast4] }));
  const statements = parseVanguardStatementApiResponse({ statements: [
    {
      endDate: '2026-07-31',
      productAccountData: 'XXXX1111',
      statementDescription: 'Individual brokerage XXXX1111',
      statementId: 'brokerage-document',
    },
    {
      endDate: '2026-06-30T00:00:00Z',
      accountId: 'remote-account-2222',
      statementId: 'roth-document',
    },
    {
      endDate: '2026-03-31',
      statementDescription: 'Traditional IRA account 00003333',
      statementId: 'traditional-document',
    },
    {
      endDate: '2026-07-31',
      statementDescription: 'Unrelated account 00004444',
      statementId: 'unrelated-document',
    },
  ] }, routes);

  expect(statements.map(statement => ({
    accountKind: statement.accountKind,
    accountLast4: statement.accountLast4,
    statementDate: statement.statementDate,
    statementId: statement.request.headers?.statementid,
  }))).toEqual([
    {
      accountKind: 'brokerage',
      accountLast4: '1111',
      statementDate: '2026-07-31',
      statementId: 'brokerage-document',
    },
    {
      accountKind: 'roth-ira',
      accountLast4: '2222',
      statementDate: '2026-06-30',
      statementId: 'roth-document',
    },
    {
      accountKind: 'traditional-ira',
      accountLast4: '3333',
      statementDate: '2026-03-31',
      statementId: 'traditional-document',
    },
  ]);
  expect(() => parseVanguardStatementApiResponse({ statements: [{
    endDate: '2026-07-31',
    statementDescription: 'Accounts XXXX1111 and XXXX2222',
    statementId: 'ambiguous-document',
  }] }, routes)).toThrow('ambiguous across local accounts');
  expect(() => parseVanguardStatementApiResponse({ statements: [{
    endDate: '2026-07-31',
    statementDescription: 'Account XXXX1111',
    statementId: '',
  }] }, routes)).toThrow('no document identity');
});

test('Vanguard builds the authenticated activity API request without browser controls', () => {
  const account = apiAccount('1111', 'Individual brokerage', 'Brokerage');
  const request = vanguardActivityApiRequest(
    account,
    '2026-01-02',
    '2026-08-03',
    'Example Browser',
    'example-xsrf-token',
  );

  expect(request.url).toBe(
    'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofu-accounts-transactions',
  );
  expect(request.method).toBe('POST');
  expect(request.headers).toEqual({
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    referer: 'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofx-welcome',
    'x-xsrf-token': 'example-xsrf-token',
  });
  expect(JSON.parse(request.body!)).toEqual({
    downloadOptionSelect: '2',
    downloadDateSelect: '5',
    fromDate: '01/02/2026',
    toDate: '08/03/2026',
    selectedAccounts: [account],
    userAgent: 'Example Browser',
    isSingle: false,
  });
  expect(() => vanguardActivityApiRequest(
    account,
    '2026-08-03',
    '2026-01-02',
    'Example Browser',
    'example-xsrf-token',
  )).toThrow('cannot be after');
});

test('Vanguard unwraps only a CSV activity API envelope', () => {
  const csv = [
    'Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type,',
    '00001111,2026-07-16,2026-07-16,Funds Received,Electronic Bank Transfer,CASH,,0,0,400.00,0,400.00,0,CASH,',
  ].join('\n');

  expect(vanguardActivityCsvFromEnvelope({
    body: csv,
    headers: { 'Content-Type': ['text/csv;charset=UTF-8'] },
  })).toBe(csv);
  expect(() => vanguardActivityCsvFromEnvelope({
    body: csv,
    headers: { 'content-type': 'text/html' },
  })).toThrow('unexpected content type');
  expect(() => vanguardActivityCsvFromEnvelope({
    body: 'not,csv',
    headers: { 'content-type': 'text/csv' },
  })).toThrow('expected CSV format');
});

test('Vanguard validates activity signature, account identity, and the matching EasyMoney parser', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vanguard-validator-'));
  const path = join(directory, 'vanguard-example-brokerage-2026-01-01-to-2026-08-01-activity.csv');
  const csv = [
    'Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,',
    '00001111,EXAMPLE FUND,VTI,1,100,100,',
    '',
    'Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type,',
    '00001111,2026-07-16,2026-07-16,Funds Received,Electronic Bank Transfer,CASH,,0,0,400.00,0,400.00,0,CASH,',
  ].join('\n');
  try {
    await writeFile(path, csv);
    await expect(validateVanguardArtifact(path, 'csv', '1111')).resolves.toBeUndefined();
    await expect(validateVanguardArtifact(path, 'csv', '2222')).rejects.toThrow('does not match');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Vanguard institution code uses direct requests and no fixed browser sleeps', async () => {
  const source = await Bun.file(new URL('./vanguard.ts', import.meta.url)).text();

  expect(source).toContain('page.evaluate(vanguardBrowserFetchInPage');
  expect(source).toContain("credentials: 'include'");
  expect(source).not.toContain('page.context().request');
  expect(source).not.toContain('waitForTimeout');
  expect(source).not.toContain("waitForEvent('download'");
  expect(source).not.toContain('.setChecked(');
  expect(source).not.toContain('.selectOption(');
  expect(source).not.toContain('c11n-icon');
  expect(source).toContain('ofu-accounts-transactions');
  expect(source).toContain('lah-statements-consumer/statements/consumer');
  expect(source).toContain('lah-statements-consumer/statements/pdf');
});
