import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wellsFargoActivityParser } from '../../importParsers/wellsFargoActivity.ts';
import { parseWellsFargoStatementText } from '../../importParsers/moneyParsers/wells-fargo-statement-pdf.ts';
import {
  buildWellsFargoBrowserProgram,
  clickWellsFargoAccountControl,
  createWellsFargoProgress,
  ensureWellsFargoAccountSummary,
  isWellsFargoAuthenticatedPage,
  isWellsFargoActivityDownloadRequest,
  isWellsFargoStatementDownloadRequest,
  mapWellsFargoAccounts,
  openWellsFargoAccount,
  parseWellsFargoAccountCandidates,
  restoreWellsFargoStatementPage,
  safeWellsFargoDiagnostic,
  setWellsFargoActivityDates,
  selectWellsFargoStatements,
  validateWellsFargoArtifact,
  wellsFargoAccountLast4FromLabel,
  wellsFargoActivityBodyFromApiResponse,
  wellsFargoActivityRequestFromForm,
  wellsFargoArtifactResponse,
  wellsFargoArtifactPlanFromFilename,
  wellsFargoDateFromText,
  wellsFargoBrowserWindowProgress,
  wellsFargoCapturedStatementResponse,
  wellsFargoStatementBodyFromApiResponse,
  wellsFargoStatementDateTextVariants,
  wellsFargoStatementDocumentUrl,
  type WellsFargoProgressEvent,
} from './wellsFargo.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test('Wells Fargo progress reports PII-free elapsed phase timing', () => {
  const events: WellsFargoProgressEvent[] = [];
  let now = 100;
  const report = createWellsFargoProgress(
    event => events.push(event),
    () => now,
    () => '2026-08-24T00:00:00.000Z',
  );

  report({
    step: 'activity-validation',
    status: 'started',
    message: 'Validating Wells Fargo activity with EasyMoney',
    accountIndex: 1,
    accountCount: 2,
    accountKind: 'checking',
    artifactKind: 'activity',
  });
  now = 142;
  report({
    step: 'activity-validation',
    status: 'completed',
    message: 'Wells Fargo activity validation complete',
    accountIndex: 1,
    accountCount: 2,
    accountKind: 'checking',
    artifactKind: 'activity',
    byteLength: 512,
    transactionCount: 3,
    balanceCount: 0,
    parserValidated: true,
  });

  expect(events).toEqual([
    expect.objectContaining({
      status: 'started',
      timestamp: '2026-08-24T00:00:00.000Z',
    }),
    expect.objectContaining({
      status: 'completed',
      elapsedMs: 42,
      parserValidated: true,
      transactionCount: 3,
    }),
  ]);
  expect(JSON.stringify(events)).not.toMatch(/\b\d{4}\b(?!-)/);
});

test('Wells Fargo diagnostics redact URLs, account digits, email, amounts, and secrets', () => {
  const diagnostic = safeWellsFargoDiagnostic(
    new Error('Account 1234 5678 user@example.test $1,234.56 token=secret https://example.test/private'),
  );

  expect(diagnostic).not.toContain('1234');
  expect(diagnostic).not.toContain('user@example.test');
  expect(diagnostic).not.toContain('$1,234.56');
  expect(diagnostic).not.toContain('token=secret');
  expect(diagnostic).toContain('<redacted-secret>');
  expect(diagnostic).not.toContain('https://');
});

test('Wells Fargo forwards the shared headed-window proof through safe progress', () => {
  const message = 'Authentication browser delivered: headed=true nativeWindow=true windowState=normal onScreen=true activation=macos-requested';
  expect(wellsFargoBrowserWindowProgress(message)).toMatchObject({
    step: 'browser-window',
    status: 'completed',
    message,
  });
  expect(wellsFargoBrowserWindowProgress('Waiting for account 1234 at https://example.test')).toMatchObject({
    step: 'browser-window',
    status: 'waiting',
    message: 'Waiting for account <redacted-digits> at <redacted-url>',
  });
});

test('Wells Fargo authentication probe waits for a delayed account marker', async () => {
  let disposed = false;
  let observedTimeout = 0;
  const page = {
    url: () => 'https://connect.secure.wellsfargo.com/accounts/start',
    waitForFunction: async (_predicate: unknown, _argument: unknown, options: { timeout: number }) => {
      observedTimeout = options.timeout;
      return {
        jsonValue: async () => 'authenticated',
        dispose: async () => { disposed = true; },
      };
    },
  } as unknown as Parameters<typeof isWellsFargoAuthenticatedPage>[0];

  await expect(isWellsFargoAuthenticatedPage(page, 250)).resolves.toBe(true);
  expect(observedTimeout).toBeGreaterThan(0);
  expect(observedTimeout).toBeLessThanOrEqual(250);
  expect(disposed).toBe(true);
});

test('Wells Fargo authentication probe rejects a rendered login page', async () => {
  const page = {
    url: () => 'https://connect.secure.wellsfargo.com/auth/login/present',
    waitForFunction: async () => ({
      jsonValue: async () => 'login-required',
      dispose: async () => {},
    }),
  } as unknown as Parameters<typeof isWellsFargoAuthenticatedPage>[0];

  await expect(isWellsFargoAuthenticatedPage(page, 250)).resolves.toBe(false);
});

test('Wells Fargo authentication probe retries an authentication redirect race', async () => {
  let attempts = 0;
  let loadStateWaits = 0;
  const page = {
    url: () => 'https://connect.secure.wellsfargo.com/accounts/start',
    isClosed: () => false,
    waitForLoadState: async () => { loadStateWaits += 1; },
    waitForFunction: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Execution context was destroyed during navigation');
      return {
        jsonValue: async () => 'authenticated',
        dispose: async () => {},
      };
    },
  } as unknown as Parameters<typeof isWellsFargoAuthenticatedPage>[0];

  await expect(isWellsFargoAuthenticatedPage(page, 250)).resolves.toBe(true);
  expect(attempts).toBe(2);
  expect(loadStateWaits).toBe(1);
});

test('Wells Fargo authentication probe rejects an off-origin page without inspecting it', async () => {
  let inspected = false;
  const page = {
    url: () => 'https://example.test/accounts/start',
    waitForFunction: async () => {
      inspected = true;
      throw new Error('unexpected inspection');
    },
  } as unknown as Parameters<typeof isWellsFargoAuthenticatedPage>[0];

  await expect(isWellsFargoAuthenticatedPage(page, 250)).resolves.toBe(false);
  expect(inspected).toBe(false);
});

test('Wells Fargo discovery covers every supported account without a fixed count or product name', () => {
  const accounts = parseWellsFargoAccountCandidates([
    {
      label: 'Everyday Checking Account number ending in 1001',
      destination: '/accounts/deposit/one',
    },
    {
      label: 'Preferred Checking Account number ending in 1002',
      destination: '/accounts/deposit/two',
    },
    {
      label: 'Goal Savings Account number ending in 2001',
      destination: '/accounts/deposit/three',
    },
    {
      label: 'Rewards Visa Card Account number ending in 3001',
      destination: '/accounts/card/four',
    },
    {
      label: 'Cash Mastercard Account number ending in 3002',
      destination: '/accounts/card/five',
    },
    {
      label: 'Home Mortgage Account number ending in 9001',
      destination: '/accounts/mortgage/six',
    },
  ], 'https://connect.secure.wellsfargo.com/account-summary');

  expect(accounts.map(account => ({ kind: account.kind, last4: account.last4 }))).toEqual([
    { kind: 'checking', last4: '1001' },
    { kind: 'checking', last4: '1002' },
    { kind: 'savings', last4: '2001' },
    { kind: 'credit-card', last4: '3001' },
    { kind: 'credit-card', last4: '3002' },
  ]);
});

test('Wells Fargo discovery accepts the live button label ellipsis and detail-page kind', () => {
  expect(wellsFargoAccountLast4FromLabel('Synthetic Product Account number ending in...1234'))
    .toBe('1234');
  expect(parseWellsFargoAccountCandidates([{
    label: 'Synthetic Product Account number ending in...1234',
    observedKind: 'checking',
  }])).toEqual([{ kind: 'checking', last4: '1234' }]);
});

test('Wells Fargo account navigation waits for detail controls instead of URL change', async () => {
  let clicked = false;
  let waitForUrlCount = 0;
  const waitedRoles: string[] = [];
  const page = {
    url: () => 'https://connect.secure.wellsfargo.com/accounts/inquiry/summary/home/default',
    waitForURL: async () => { waitForUrlCount += 1; },
    getByRole: (role: string) => ({
      first() { return this; },
      waitFor: async () => { waitedRoles.push(role); },
    }),
  } as unknown as Parameters<typeof clickWellsFargoAccountControl>[0];
  const control = {
    getAttribute: async () => '/accounts/detail',
    click: async () => { clicked = true; },
  } as unknown as Parameters<typeof clickWellsFargoAccountControl>[1];

  expect(await clickWellsFargoAccountControl(page, control)).toBe(true);

  expect(clicked).toBe(true);
  expect(waitForUrlCount).toBe(0);
  expect(waitedRoles).toContain('button');
  expect(waitedRoles).toContain('link');
});

test('Wells Fargo account navigation accepts authenticated detail controls without a summary marker', async () => {
  let currentUrl = 'https://connect.secure.wellsfargo.com/accounts/start';
  const accountControl = {
    getAttribute: async () => '/accounts/detail',
    click: async () => { currentUrl = 'https://connect.secure.wellsfargo.com/accounts/detail'; },
  };
  const summaryHeading = {
    first() { return this; },
    isVisible: async () => true,
  };
  const detailControl = {
    first() { return this; },
    waitFor: async () => {},
  };
  const accountControls = {
    filter() { return this; },
    allTextContents: async () => ['Checking Account number ending in 1234'],
    nth: () => accountControl,
  };
  const page = {
    url: () => currentUrl,
    getByRole: (role: string, options?: { name?: RegExp }) => {
      if (role === 'heading' && options?.name) return summaryHeading;
      if (role === 'heading') return { allTextContents: async () => ['Everyday Checking'] };
      if (role === 'link' && !options) return accountControls;
      return detailControl;
    },
  } as unknown as Parameters<typeof openWellsFargoAccount>[0];

  await expect(openWellsFargoAccount(page, {
    kind: 'checking',
    last4: '1234',
  })).resolves.toBeUndefined();
  expect(currentUrl).toBe('https://connect.secure.wellsfargo.com/accounts/detail');
});

test('Wells Fargo discovery skips rewards SSO links before opening them', async () => {
  let clicked = false;
  const page = {
    url: () => 'https://connect.secure.wellsfargo.com/accounts/inquiry/summary/home/default',
    getByRole: () => ({
      first() { return this; },
      waitFor: async () => {
        throw new Error('account details unavailable');
      },
    }),
  } as unknown as Parameters<typeof clickWellsFargoAccountControl>[0];
  const control = {
    getAttribute: async () => 'https://idp.wellsfargo.com/sso/initiate?synthetic=true',
    click: async () => { clicked = true; },
  } as unknown as Parameters<typeof clickWellsFargoAccountControl>[1];

  expect(await clickWellsFargoAccountControl(page, control, {
    allowUnsupportedDestination: true,
  })).toBe(false);
  expect(clicked).toBe(false);
});

test('Wells Fargo discovery rejects ambiguous routing identities', () => {
  expect(() => parseWellsFargoAccountCandidates([
    {
      label: 'First Checking Account number ending in 1234',
      destination: '/accounts/deposit/first',
    },
    {
      label: 'Second Checking Account number ending in 1234',
      destination: '/accounts/deposit/second',
    },
  ], 'https://connect.secure.wellsfargo.com/account-summary')).toThrow('ambiguous routing identity');
});

test('Wells Fargo discovery rejects cross-origin account destinations', () => {
  expect(() => parseWellsFargoAccountCandidates([
    {
      label: 'Checking Account number ending in 1234',
      destination: 'https://example.test/accounts/one',
    },
  ])).toThrow('invalid API destination');
});

test('Wells Fargo returns through same-document account history before using the login fallback', async () => {
  let historyIndex = 2;
  let linkClickCount = 0;
  let gotoCount = 0;
  const heading = {
    first() { return this; },
    isVisible: async () => historyIndex === 0,
    waitFor: async () => {
      if (historyIndex !== 0) throw new Error('not visible');
    },
  };
  const link = {
    first() { return this; },
    isVisible: async () => false,
    click: async () => { linkClickCount += 1; },
  };
  const page = {
    url: () => 'https://connect.secure.wellsfargo.com/accounts',
    goBack: async () => {
      if (historyIndex > 0) historyIndex -= 1;
      return null;
    },
    goto: async () => { gotoCount += 1; },
    getByRole: (role: string) => role === 'heading' ? heading : link,
  } as unknown as Parameters<typeof ensureWellsFargoAccountSummary>[0];

  await ensureWellsFargoAccountSummary(page);

  expect(historyIndex).toBe(0);
  expect(linkClickCount).toBe(0);
  expect(gotoCount).toBe(0);
});

test('Wells Fargo uses a visible account-summary link without walking back into login history', async () => {
  let summaryVisible = false;
  let goBackCount = 0;
  let gotoCount = 0;
  const heading = {
    first() { return this; },
    isVisible: async () => summaryVisible,
    waitFor: async () => {
      if (!summaryVisible) throw new Error('not visible');
    },
  };
  const link = {
    first() { return this; },
    isVisible: async () => true,
    click: async () => { summaryVisible = true; },
  };
  const page = {
    url: () => 'https://connect.secure.wellsfargo.com/accounts/detail',
    goBack: async () => { goBackCount += 1; return null; },
    goto: async () => { gotoCount += 1; },
    getByRole: (role: string) => role === 'heading' ? heading : link,
  } as unknown as Parameters<typeof ensureWellsFargoAccountSummary>[0];

  await ensureWellsFargoAccountSummary(page);

  expect(goBackCount).toBe(0);
  expect(gotoCount).toBe(0);
});

test('Wells Fargo stops history traversal at a cross-origin page and opens account summary directly', async () => {
  let currentUrl = 'https://connect.secure.wellsfargo.com/accounts/detail';
  let summaryVisible = false;
  let goBackCount = 0;
  let gotoCount = 0;
  const heading = {
    first() { return this; },
    isVisible: async () => summaryVisible,
    waitFor: async () => {
      if (!summaryVisible) throw new Error('not visible');
    },
  };
  const link = {
    first() { return this; },
    isVisible: async () => false,
    click: async () => {},
  };
  const page = {
    url: () => currentUrl,
    goBack: async () => {
      goBackCount += 1;
      currentUrl = 'https://example.test/outside';
      return null;
    },
    goto: async (url: string) => {
      gotoCount += 1;
      currentUrl = url;
      summaryVisible = true;
    },
    getByRole: (role: string) => role === 'heading' ? heading : link,
  } as unknown as Parameters<typeof ensureWellsFargoAccountSummary>[0];

  await ensureWellsFargoAccountSummary(page);

  expect(goBackCount).toBe(1);
  expect(gotoCount).toBe(1);
  expect(currentUrl).toBe('https://connect.secure.wellsfargo.com/accounts/start');
});

test('Wells Fargo opens account summary directly after bounded document history is exhausted', async () => {
  let summaryVisible = false;
  let goBackCount = 0;
  let gotoUrl = '';
  const heading = {
    first() { return this; },
    isVisible: async () => summaryVisible,
    waitFor: async () => {
      if (!summaryVisible) throw new Error('not visible');
    },
  };
  const link = {
    first() { return this; },
    isVisible: async () => false,
    click: async () => {},
  };
  const page = {
    url: () => gotoUrl || 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/synthetic',
    goBack: async () => {
      goBackCount += 1;
      return null;
    },
    goto: async (url: string) => {
      gotoUrl = url;
      summaryVisible = true;
    },
    getByRole: (role: string) => role === 'heading' ? heading : link,
  } as unknown as Parameters<typeof ensureWellsFargoAccountSummary>[0];

  await ensureWellsFargoAccountSummary(page);

  expect(goBackCount).toBe(3);
  expect(gotoUrl).toBe(
    'https://connect.secure.wellsfargo.com/accounts/start',
  );
});

test('Wells Fargo maps every planned local account while ignoring unrelated remote accounts', () => {
  const checking = {
    kind: 'checking' as const,
    last4: '1001',
  };
  const mapped = mapWellsFargoAccounts([
    checking,
    {
      kind: 'credit-card',
      last4: '9001',
    },
  ], [{
    accountId: 42,
    kind: 'checking',
    last4: '1001',
    activityFrom: '2026-07-01',
    activityThrough: '2026-08-01',
    statementFrom: '2026-06-30',
    statementThrough: '2026-08-01',
  }]);

  expect(mapped).toEqual([{
    remote: checking,
    planned: {
      accountId: 42,
      kind: 'checking',
      last4: '1001',
      activityFrom: '2026-07-01',
      activityThrough: '2026-08-01',
      statementFrom: '2026-06-30',
      statementThrough: '2026-08-01',
    },
  }]);
});

test('Wells Fargo rejects missing and ambiguous planned identities before downloading', () => {
  const plan = {
    accountId: 42,
    kind: 'checking' as const,
    last4: '1001',
    activityFrom: '2026-07-01',
    activityThrough: '2026-08-01',
    statementFrom: '2026-06-30',
    statementThrough: '2026-08-01',
  };
  expect(() => mapWellsFargoAccounts([], [plan])).toThrow('unavailable');
  expect(() => mapWellsFargoAccounts([
    {
      kind: 'checking',
      last4: '1001',
    },
  ], [plan, { ...plan, accountId: 43 }])).toThrow('ambiguous routing identity');
});

test('Wells Fargo activity form metadata becomes a same-origin direct HTTP request', () => {
  const request = wellsFargoActivityRequestFromForm({
    action: '/activity/download',
    method: 'post',
    fields: [
      ['fromDate', '07/01/2026'],
      ['toDate', '08/01/2026'],
      ['format', 'csv'],
      ['csrf', 'synthetic-token'],
    ],
  }, 'https://connect.secure.wellsfargo.com/accounts/activity');

  expect(request).toEqual({
    url: 'https://connect.secure.wellsfargo.com/activity/download',
    method: 'POST',
    body: 'fromDate=07%2F01%2F2026&toDate=08%2F01%2F2026&format=csv&csrf=synthetic-token',
  });
  expect(() => wellsFargoActivityRequestFromForm({
    action: 'https://example.test/activity/download',
    method: 'post',
    fields: [],
  }, 'https://connect.secure.wellsfargo.com/accounts/activity')).toThrow('invalid API destination');
});

test('Wells Fargo identifies only its authenticated activity download XHR', () => {
  const request = (overrides: Partial<{
    method: string;
    postData: string | null;
    resourceType: string;
    url: string;
  }> = {}) => ({
    method: () => overrides.method ?? 'POST',
    postData: () => overrides.postData ?? '{"query":"mutation downloadAccountData"}',
    resourceType: () => overrides.resourceType ?? 'xhr',
    url: () => overrides.url ?? 'https://connect.secure.wellsfargo.com/web/oapi/graphql',
  });

  expect(isWellsFargoActivityDownloadRequest(request())).toBe(true);
  expect(isWellsFargoActivityDownloadRequest(request({ method: 'GET' }))).toBe(false);
  expect(isWellsFargoActivityDownloadRequest(request({ postData: '{"query":"accountSummary"}' }))).toBe(false);
  expect(isWellsFargoActivityDownloadRequest(request({ url: 'https://example.test/web/oapi/graphql' }))).toBe(false);
});

test('Wells Fargo identifies only same-origin statement document requests', () => {
  const pageUrl = 'https://connect.secure.wellsfargo.com/statements';
  const request = (overrides: Partial<{
    method: string;
    resourceType: string;
    url: string;
  }> = {}) => ({
    method: () => overrides.method ?? 'GET',
    resourceType: () => overrides.resourceType ?? 'document',
    url: () => overrides.url ??
      'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/synthetic',
  });

  expect(isWellsFargoStatementDownloadRequest(request(), pageUrl)).toBe(true);
  expect(isWellsFargoStatementDownloadRequest(request({ method: 'POST', resourceType: 'xhr' }), pageUrl))
    .toBe(true);
  expect(isWellsFargoStatementDownloadRequest(request({ method: 'DELETE' }), pageUrl)).toBe(false);
  expect(isWellsFargoStatementDownloadRequest(request({ resourceType: 'image' }), pageUrl)).toBe(false);
  expect(isWellsFargoStatementDownloadRequest(request({
    url: 'https://connect.secure.wellsfargo.com/edocs/documents/preview/synthetic',
  }), pageUrl)).toBe(false);
  expect(isWellsFargoStatementDownloadRequest(request({
    url: 'https://example.test/edocs/documents/retrieve/synthetic',
  }), pageUrl)).toBe(false);
  expect(isWellsFargoStatementDownloadRequest(request({
    url: 'https://other.wellsfargo.com/edocs/documents/retrieve/synthetic',
  }), pageUrl)).toBe(false);
});

test('Wells Fargo accepts only verified same-origin statement document links', () => {
  const pageUrl = 'https://connect.secure.wellsfargo.com/statements';
  expect(wellsFargoStatementDocumentUrl(
    '/edocs/documents/retrieve/synthetic',
    pageUrl,
  )).toBe('https://connect.secure.wellsfargo.com/edocs/documents/retrieve/synthetic');
  expect(wellsFargoStatementDocumentUrl(
    'https://other.wellsfargo.com/edocs/documents/retrieve/synthetic',
    pageUrl,
  )).toBeNull();
  expect(wellsFargoStatementDocumentUrl(
    'https://example.test/edocs/documents/retrieve/synthetic',
    pageUrl,
  )).toBeNull();
  expect(wellsFargoStatementDocumentUrl('javascript:void(0)', pageUrl)).toBeNull();
  expect(wellsFargoStatementDocumentUrl('/contact-us', pageUrl)).toBeNull();
});

test('Wells Fargo restores its statement list after an intercepted document navigation', async () => {
  const statementPageUrl = 'https://connect.secure.wellsfargo.com/edocs/statements?synthetic=true';
  let currentUrl = 'chrome-error://chromewebdata/';
  let gotoCount = 0;
  const page = {
    isClosed: () => false,
    url: () => currentUrl,
    goBack: async () => {
      currentUrl = statementPageUrl;
      return null;
    },
    goto: async () => {
      gotoCount += 1;
      return null;
    },
  } as unknown as Parameters<typeof restoreWellsFargoStatementPage>[0];

  expect(await restoreWellsFargoStatementPage(page, statementPageUrl)).toBe(true);
  expect(gotoCount).toBe(0);
});

test('Wells Fargo reloads its verified statement list when browser history cannot restore it', async () => {
  const statementPageUrl = 'https://connect.secure.wellsfargo.com/edocs/statements';
  let currentUrl = 'about:blank';
  let gotoUrl = '';
  const page = {
    isClosed: () => false,
    url: () => currentUrl,
    goBack: async () => null,
    goto: async (url: string) => {
      gotoUrl = url;
      currentUrl = url;
      return null;
    },
  } as unknown as Parameters<typeof restoreWellsFargoStatementPage>[0];

  expect(await restoreWellsFargoStatementPage(page, statementPageUrl)).toBe(true);
  expect(gotoUrl).toBe(statementPageUrl);
});

test('Wells Fargo decodes the authenticated activity API JSON into CSV bytes', () => {
  const csv = Buffer.from('Date,Amount,Description\n09/01/2026,-12.34,Synthetic\n');
  const response = {
    status: 200,
    url: 'https://connect.secure.wellsfargo.com/web/oapi/graphql',
    headers: { 'content-type': 'application/json;charset=UTF-8' },
    bodyBase64: Buffer.from(JSON.stringify({
      data: {
        downloadAccountData: {
          status: true,
          fileName: 'activity.csv',
          activities: csv.toString('base64'),
        },
      },
    })).toString('base64'),
    redirected: false,
  };

  expect(wellsFargoActivityBodyFromApiResponse(response)).toEqual(csv);
  expect(wellsFargoActivityBodyFromApiResponse({
    ...response,
    bodyBase64: Buffer.from(JSON.stringify({
      data: { downloadAccountData: { status: true, activities: csv.toString('utf8') } },
    })).toString('base64'),
  })).toEqual(csv);
  expect(wellsFargoActivityBodyFromApiResponse({
    ...response,
    bodyBase64: Buffer.from(JSON.stringify({
      data: { downloadAccountData: { status: true, activities: encodeURIComponent(csv.toString('utf8')) } },
    })).toString('base64'),
  })).toEqual(csv);
  expect(wellsFargoActivityBodyFromApiResponse({
    ...response,
    bodyBase64: Buffer.from(JSON.stringify({
      data: {
        downloadAccountData: {
          status: true,
          activities: `data:text/csv;charset=utf-8;base64,${csv.toString('base64')}`,
        },
      },
    })).toString('base64'),
  })).toEqual(csv);
  expect(wellsFargoActivityBodyFromApiResponse({
    ...response,
    bodyBase64: Buffer.from(JSON.stringify({
      data: {
        downloadAccountData: {
          status: true,
          activities: Buffer.from([251, 255]).toString('base64url').replace(/=+$/, ''),
        },
      },
    })).toString('base64'),
  })).toEqual(Buffer.from([251, 255]));
  expect(() => wellsFargoActivityBodyFromApiResponse({
    ...response,
    bodyBase64: Buffer.from(JSON.stringify({
      data: { downloadAccountData: { status: false, activities: csv.toString('base64') } },
    })).toString('base64'),
  })).toThrow('omitted a completed download');
  expect(() => wellsFargoActivityBodyFromApiResponse({
    ...response,
    bodyBase64: Buffer.from(JSON.stringify({
      data: { downloadAccountData: { status: true, activities: 'not base64!' } },
    })).toString('base64'),
  })).toThrow('invalid base64');
});

test('Wells Fargo accepts raw and JSON-embedded statement PDF bytes', () => {
  const pdf = Buffer.from('%PDF-1.7\nsynthetic statement bytes'.padEnd(128, 'x'));
  const response = {
    status: 200,
    url: 'https://connect.secure.wellsfargo.com/documents/synthetic',
    headers: { 'content-type': 'application/pdf' },
    bodyBase64: pdf.toString('base64'),
    redirected: false,
  };

  expect(wellsFargoStatementBodyFromApiResponse(response)).toEqual(pdf);
  expect(wellsFargoStatementBodyFromApiResponse({
    ...response,
    headers: { 'content-type': 'application/json' },
    bodyBase64: Buffer.from(JSON.stringify({
      data: { document: pdf.toString('base64') },
    })).toString('base64'),
  })).toEqual(pdf);
  expect(wellsFargoStatementBodyFromApiResponse({
    ...response,
    headers: { 'content-type': 'application/json' },
    bodyBase64: Buffer.from(JSON.stringify({
      data: { document: `data:application/pdf;base64,${pdf.toString('base64')}` },
    })).toString('base64'),
  })).toEqual(pdf);
  expect(() => wellsFargoStatementBodyFromApiResponse({
    ...response,
    bodyBase64: Buffer.from('{}').toString('base64'),
  })).toThrow('did not contain one PDF');
});

test('Wells Fargo retains only validated same-origin statement response bytes', () => {
  const pageUrl = 'https://connect.secure.wellsfargo.com/edocs/statements';
  const pdf = Buffer.from('%PDF-1.7\nsynthetic statement bytes'.padEnd(128, 'x'));
  const response = {
    status: 200,
    url: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/synthetic',
    headers: {
      'Content-Type': 'application/pdf',
      'Set-Cookie': 'must-not-be-forwarded',
    },
    redirected: false,
  };

  expect(wellsFargoCapturedStatementResponse(response, pdf, pageUrl)).toEqual({
    status: 200,
    url: response.url,
    headers: { 'content-type': 'application/pdf' },
    bodyBase64: pdf.toString('base64'),
    redirected: false,
  });
  expect(wellsFargoCapturedStatementResponse(
    { ...response, url: 'https://example.test/document.pdf' },
    pdf,
    pageUrl,
  )).toBeNull();
  expect(wellsFargoCapturedStatementResponse(
    response,
    Buffer.from('not a PDF'),
    pageUrl,
  )).toBeNull();
  expect(wellsFargoCapturedStatementResponse(
    { ...response, status: 400 },
    pdf,
    pageUrl,
  )).toBeNull();
});

test('Wells Fargo reuses a captured statement response without replaying its one-time request', async () => {
  const request = {
    url: 'https://connect.secure.wellsfargo.com/web/oapi/graphql',
    method: 'POST' as const,
    body: '{"operationName":"SyntheticDocument"}',
  };
  const capturedResponse = {
    status: 200,
    url: request.url,
    headers: { 'content-type': 'application/pdf' },
    bodyBase64: Buffer.from('%PDF-1.7\nsynthetic').toString('base64'),
    redirected: false,
  };
  expect(await wellsFargoArtifactResponse(
    {} as never,
    'statement',
    request,
    capturedResponse,
  )).toBe(capturedResponse);
  await expect(wellsFargoArtifactResponse(
    {} as never,
    'activity',
    request,
    capturedResponse,
  )).rejects.toThrow('did not belong to a statement');
  await expect(wellsFargoArtifactResponse(
    {} as never,
    'statement',
    request,
    { ...capturedResponse, url: 'https://example.test/document' },
  )).rejects.toThrow('invalid API destination');
});

test('Wells Fargo updates controlled activity dates without Playwright fill', async () => {
  const values: string[] = [];
  const fields = {
    nth: (index: number) => ({
      waitFor: async () => {},
      evaluate: async (_callback: unknown, value: string) => { values[index] = value; },
    }),
    count: async () => 2,
  };
  const page = {
    getByRole: () => fields,
  } as unknown as Parameters<typeof setWellsFargoActivityDates>[0];

  await setWellsFargoActivityDates(page, '2026-04-05', '2026-09-07');

  expect(values).toEqual(['04/05/2026', '09/07/2026']);
});

test('Wells Fargo GET activity forms preserve every discovered field', () => {
  const request = wellsFargoActivityRequestFromForm({
    action: '/activity/download?channel=online',
    method: 'get',
    fields: [['account', 'synthetic'], ['format', 'csv']],
  }, 'https://connect.secure.wellsfargo.com/accounts/activity');

  expect(request.method).toBe('GET');
  expect(new URL(request.url).searchParams.get('channel')).toBe('online');
  expect(new URL(request.url).searchParams.get('account')).toBe('synthetic');
  expect(new URL(request.url).searchParams.get('format')).toBe('csv');
});

test('Wells Fargo statement selection includes the latest opening anchor and every in-range document', () => {
  const statements = selectWellsFargoStatements([
    {
      date: '2026-05-31',
      request: {
        url: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/opening',
        method: 'GET',
      },
    },
    {
      date: '2026-06-30',
      request: {
        url: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/june',
        method: 'GET',
      },
    },
    {
      date: '2026-07-31',
      request: {
        url: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/july',
        method: 'GET',
      },
    },
    {
      date: '2026-08-31',
      request: {
        url: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/august',
        method: 'GET',
      },
    },
  ], '2026-06-15', '2026-08-01');

  expect(statements.map(statement => statement.date)).toEqual([
    '2026-05-31',
    '2026-06-30',
    '2026-07-31',
  ]);
});

test('Wells Fargo statement selection rejects ambiguous same-date documents', () => {
  expect(() => selectWellsFargoStatements([
    {
      date: '2026-07-31',
      request: {
        url: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/first',
        method: 'GET',
      },
    },
    {
      date: '2026-07-31',
      request: {
        url: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/second',
        method: 'GET',
      },
    },
  ], '2026-07-01', '2026-08-01')).toThrow('multiple statement documents');
});

test('Wells Fargo accepts a non-legacy request path only after observing a document response', () => {
  const candidate = {
    date: '2026-07-31',
    request: {
      url: 'https://connect.secure.wellsfargo.com/web/oapi/graphql',
      method: 'POST' as const,
      body: '{"operationName":"SyntheticDocument"}',
    },
  };
  expect(() => selectWellsFargoStatements(
    [candidate],
    '2026-07-01',
    '2026-08-01',
  )).toThrow('did not expose the verified document API');

  expect(selectWellsFargoStatements(
    [{ ...candidate, verification: 'observed-document-response' }],
    '2026-07-01',
    '2026-08-01',
  )).toEqual([{ ...candidate, verification: 'observed-document-response' }]);
});

test('Wells Fargo statement dates normalize observed numeric, named, and ISO forms', () => {
  expect(wellsFargoDateFromText('Statement 8/1/2026')).toBe('2026-08-01');
  expect(wellsFargoDateFromText('August 1, 2026 statement')).toBe('2026-08-01');
  expect(wellsFargoDateFromText('/retrieve/2026-08-01')).toBe('2026-08-01');
  expect(wellsFargoDateFromText('Statement available')).toBeNull();
});

test('Wells Fargo statement date variants survive client-side display-format changes', () => {
  expect(wellsFargoStatementDateTextVariants('2026-08-05')).toEqual(expect.arrayContaining([
    '2026-08-05',
    '08/05/2026',
    '8/5/2026',
    'august 5, 2026',
    'aug 5, 2026',
  ]));
  expect(() => wellsFargoStatementDateTextVariants('08/05/2026')).toThrow(
    'must use YYYY-MM-DD',
  );
});

test('Wells Fargo artifact filenames identify account kind, last four, and coverage', () => {
  expect(wellsFargoArtifactPlanFromFilename(
    '/private/tmp/wells-fargo-savings-2468-2026-07-01-to-2026-08-01.csv',
  )).toMatchObject({
    fileName: 'wells-fargo-savings-2468-2026-07-01-to-2026-08-01.csv',
    kind: 'activity',
    account: { kind: 'savings', last4: '2468' },
    coveredFrom: '2026-07-01',
    coveredThrough: '2026-08-01',
  });
  expect(wellsFargoArtifactPlanFromFilename(
    '/private/tmp/wells-fargo-credit-card-8642-2026-07-31.pdf',
  )).toMatchObject({
    kind: 'statement',
    account: { kind: 'credit-card', last4: '8642' },
    coveredFrom: '2026-07-31',
    coveredThrough: '2026-07-31',
  });
  expect(wellsFargoArtifactPlanFromFilename('/private/tmp/wells-fargo-activity.csv')).toBeNull();
});

test('Wells Fargo activity validation runs the normalized EasyMoney parser', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wells-fargo-module-test-'));
  temporaryDirectories.push(directory);
  const fileName = 'wells-fargo-savings-2468-2026-07-01-to-2026-08-01.csv';
  const filePath = join(directory, fileName);
  const text = [
    'Date,Description,Amount,CHECK #,Status',
    '07/15/2026,Interest payment,1.25,,Posted',
  ].join('\n');
  await writeFile(filePath, text);

  const parser = wellsFargoActivityParser;
  expect(parser.matches({ fileName, headers: [], sample: text })).toBe(true);
  const parsed = await parser.parse({ fileName, filePath, headers: [], rows: [], text });
  expect(parsed.transactions[0]).toMatchObject({
    account: 'Savings - 2468',
    amountCents: 125,
    institution: 'Wells Fargo',
  });
  await expect(validateWellsFargoArtifact(filePath)).resolves.toMatchObject({
    fileName,
    kind: 'activity',
    account: { kind: 'savings', last4: '2468' },
    transactionCount: 1,
    balanceCount: 0,
  });
});

test('Wells Fargo activity validation rejects a file that the parser cannot parse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wells-fargo-module-test-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'wells-fargo-checking-1357-2026-07-01-to-2026-08-01.csv');
  await writeFile(filePath, 'Not,A,Wells,Fargo,Export\nsynthetic,row,with,enough,data');

  await expect(validateWellsFargoArtifact(filePath)).rejects.toThrow('transaction header');
});

test('Wells Fargo statement parser supports generic savings and card identities', () => {
  const savings = parseWellsFargoStatementText([
    'Wells Fargo Goal Savings',
    'Account number: 0000002468',
    'Beginning balance on 7/1 $900.00',
    'Ending balance on 8/1 $1,000.00',
    'Transaction history',
  ].join('\n'), 'wells-fargo-savings-2468-2026-08-01.pdf');
  expect(savings.balances[0]).toMatchObject({
    account: 'Savings - 2468',
    balance_cents: 100000,
  });

  const card = parseWellsFargoStatementText([
    'WELLS FARGO CREDIT CARD',
    'Account ending in 8642',
    'Statement Period 07/02/2026 to 08/01/2026',
    'New Balance $100.00',
  ].join('\n'), 'wells-fargo-credit-card-8642-2026-08-01.pdf');
  expect(card.balances[0]).toMatchObject({
    account: 'Wells Fargo Credit Card - 8642',
    balance_cents: -10000,
  });
});

test('Wells Fargo statement parser rejects a filename account mismatch', () => {
  expect(() => parseWellsFargoStatementText([
    'Wells Fargo Goal Savings',
    'Account number: 0000002468',
    'Beginning balance on 7/1 $900.00',
    'Ending balance on 8/1 $1,000.00',
    'Transaction history',
  ].join('\n'), 'wells-fargo-savings-9999-2026-08-01.pdf')).toThrow('does not match its filename');
});

test('Wells Fargo browser program uses dependency waits and direct request bindings', () => {
  const program = buildWellsFargoBrowserProgram({ accounts: [{
    accountId: 42,
    kind: 'checking',
    last4: '1001',
    activityFrom: '2026-07-01',
    activityThrough: '2026-08-01',
    statementFrom: '2026-06-30',
    statementThrough: '2026-08-01',
  }] });

  expect(program).toContain('bindings.mapAccounts');
  expect(program).toContain('bindings.prepareActivityRequest');
  expect(program).toContain('bindings.downloadArtifact');
  expect(program).toContain('statement.capturedResponse');
  expect(program).not.toContain('waitForTimeout');
  expect(program).not.toContain('setTimeout');
  expect(program).not.toContain("waitForEvent('download'");
  expect(program).not.toContain('.saveAs(');
  for (const step of [
    'sync',
    'authentication',
    'account-discovery',
    'capability-discovery',
    'activity-metadata',
    'activity-download',
    'activity-validation',
    'statement-metadata',
    'statement-download',
    'statement-validation',
  ]) {
    expect(program).toContain(`step: '${step}'`);
  }
});
