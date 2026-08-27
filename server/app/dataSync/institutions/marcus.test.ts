import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright';
import {
  buildMarcusRemoteCatalogFromApi,
  buildMarcusRemoteCatalog,
  discoverMarcusRemoteCatalog,
  executeMarcusBrowser,
  fetchMarcusDocumentBytes,
  isMarcusApiCatalogRequest,
  isMarcusAuthenticatedPath,
  mapMarcusRemoteAccounts,
  marcusAccountIdentityFromText,
  marcusDocumentRequest,
  marcusStatementDateFromText,
  planMarcusCatalog,
  readMarcusApiPayload,
  runMarcusSync,
  validateMarcusPdfSignature,
  validateMarcusStatementArtifact,
  type MarcusAccountIdentity,
  type MarcusSyncAccount,
  type MarcusSyncDependencies,
} from './marcus.ts';

const validPdf = new TextEncoder().encode([
  '%PDF-1.7',
  '1 0 obj',
  '<< /Type /Catalog >>',
  'endobj',
  'trailer',
  '<<>>',
  '%%EOF',
].join('\n'));

function fakeParser(accountName = 'Online Savings - 1111'): MarcusSyncDependencies['parser'] {
  return {
    id: 'marcus-statement-pdf',
    matches: ({ fileName }) => /^marcus-online-savings-\d{4}-\d{4}-\d{2}-\d{2}-statement\.pdf$/.test(fileName),
    parse: async () => ({
      transactions: [{
        sourceRowIndex: 0,
        date: '2026-06-15',
        amountCents: 125,
        description: 'Interest paid',
        institution: 'Marcus',
        account: accountName,
        sourceRole: 'activity',
      }],
      balances: [{
        sourceRowIndex: 0,
        date: '2026-06-30',
        balanceCents: 10_000,
        institution: 'Marcus',
        account: accountName,
      }],
    }),
  };
}

function savingsAccount(last4 = '1111'): MarcusAccountIdentity {
  return {
    kind: 'savings',
    last4,
    sourceAccountKey: `marcus:savings:${last4}`,
    parserAccountName: `Online Savings - ${last4}`,
  };
}

function plannedSavingsAccount(overrides: Partial<MarcusSyncAccount> = {}): MarcusSyncAccount {
  return {
    accountId: 10,
    kind: 'savings',
    last4: '1111',
    startDate: '2026-06-01',
    ...overrides,
  };
}

test('Marcus account and date metadata parsing is account-count agnostic', () => {
  expect(marcusAccountIdentityFromText('Online Savings Account ending in 1111')).toEqual(savingsAccount());
  expect(marcusAccountIdentityFromText('High-Yield CD - 2222')).toEqual({
    kind: 'deposit',
    last4: '2222',
    sourceAccountKey: 'marcus:deposit:2222',
    parserAccountName: null,
  });
  expect(marcusAccountIdentityFromText('Online Savings Statement June 2026')).toBeNull();
  expect(marcusAccountIdentityFromText(
    'Online Savings Account **** 1111 High-Yield CD - 2222',
  )).toBeNull();
  expect(marcusAccountIdentityFromText(
    'Online Savings Account **** 1111 Online Savings Account **** 2222',
  )).toBeNull();
  expect(marcusStatementDateFromText('Statement date 6/30/2026')).toBe('2026-06-30');
  expect(marcusStatementDateFromText('Created 2026-06-30T12:00:00Z')).toBe('2026-06-30');
  expect(marcusStatementDateFromText('June 2026 Statement')).toBe('2026-06-01');
});

test('Marcus discovers every savings and deposit account while selecting every supported document', () => {
  const catalog = buildMarcusRemoteCatalog([
    { text: 'Online Savings Account **** 1111', remoteKey: 'remote-a' },
    { text: 'High-Yield CD - 2222', remoteKey: 'remote-b' },
    { text: 'Online Savings Account **** 1111', remoteKey: 'remote-a' },
  ], [
    {
      href: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-a',
      accountText: 'Online Savings Account **** 1111',
      documentText: 'June 1, 2026 Statement',
      remoteKey: 'remote-a',
    },
    {
      href: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-a',
      accountText: 'Online Savings Account **** 1111',
      documentText: 'June 1, 2026 Statement',
      remoteKey: 'remote-a',
    },
    {
      href: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-b',
      accountText: 'High-Yield CD - 2222',
      documentText: 'June 1, 2026 Statement',
      remoteKey: 'remote-b',
    },
    {
      href: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/tax-document',
      accountText: 'Online Savings Account **** 1111',
      documentText: '2026 1099 tax document',
      remoteKey: 'remote-a',
    },
  ]);

  expect(catalog.accounts).toEqual([
    {
      kind: 'deposit',
      last4: '2222',
      sourceAccountKey: 'marcus:deposit:2222',
      parserAccountName: null,
      supportedArtifactTypes: [],
      availableArtifactCount: 0,
    },
    {
      ...savingsAccount(),
      supportedArtifactTypes: ['statement-pdf'],
      availableArtifactCount: 1,
    },
  ]);
  expect(catalog.documents).toHaveLength(1);
  expect(catalog.documents[0]).toMatchObject({
    account: savingsAccount(),
    artifactType: 'statement-pdf',
    statementDate: '2026-06-01',
    request: { method: 'GET', url: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-a' },
  });
  expect(catalog.unsupportedArtifactCount).toBe(2);
});

test('Marcus builds a dynamic account and document catalog from the observed API shapes', () => {
  const catalog = buildMarcusRemoteCatalogFromApi([{
    data: {
      savings: {
        accounts: [
          {
            accountId: 'remote-b',
            accountNumberLastFour: '2222',
            productName: 'High-Yield CD',
          },
          {
            accountId: 'remote-a',
            accountNumberLastFour: '1111',
            formattedAccountName: 'Online Savings Account',
          },
        ],
      },
    },
  }], {
    data: {
      data: {
        savingsDocumentList: {
          error: null,
          response: [
            {
              accountId: 'remote-a',
              createdDate: '2026-06-30T12:00:00Z',
              fileName: 'June 2026 Statement.pdf',
              links: [{ link: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-a' }],
            },
            {
              accountId: 'remote-b',
              createdDate: '2026-06-30T12:00:00Z',
              fileName: 'June 2026 Statement.pdf',
              links: [{ link: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-b' }],
            },
            {
              accountId: 'remote-a',
              createdDate: '2026-01-31T12:00:00Z',
              fileName: '2026 1099 tax document.pdf',
              links: [{ link: '/us/en/documents' }],
            },
          ],
        },
      },
    },
  });

  expect(catalog.accounts).toEqual([
    {
      kind: 'deposit',
      last4: '2222',
      sourceAccountKey: 'marcus:deposit:2222',
      parserAccountName: null,
      supportedArtifactTypes: [],
      availableArtifactCount: 0,
    },
    {
      ...savingsAccount(),
      supportedArtifactTypes: ['statement-pdf'],
      availableArtifactCount: 1,
    },
  ]);
  expect(catalog.documents).toEqual([{
    account: savingsAccount(),
    artifactType: 'statement-pdf',
    statementDate: '2026-06-30',
    request: {
      method: 'GET',
      url: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-a',
    },
  }]);
  expect(catalog.unsupportedArtifactCount).toBe(2);
});

test('Marcus rejects malformed or ambiguous API account and document identities', () => {
  const accounts = (records: unknown[]) => [{ data: { savings: { accounts: records } } }];
  const documents = (records: unknown[]) => ({
    data: { data: { savingsDocumentList: { response: records } } },
  });
  expect(() => buildMarcusRemoteCatalogFromApi(accounts([{
    accountId: 'remote-a',
    accountNumberLastFour: '111',
    productName: 'Online Savings Account',
  }]), documents([]))).toThrow('account API identity is unavailable');
  expect(() => buildMarcusRemoteCatalogFromApi(accounts([{
    accountId: 'remote-a',
    accountNumberLastFour: '1111',
    productName: 'Online Savings Account',
  }]), documents([{
    accountId: 'unknown-account',
    createdDate: '2026-06-30',
    fileName: 'June 2026 Statement.pdf',
    links: [{ link: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-a' }],
  }]))).toThrow('document API identity is unavailable');
  expect(() => buildMarcusRemoteCatalogFromApi(accounts([{
    accountId: 'remote-a',
    accountNumberLastFour: '1111',
    productName: 'Online Savings Account',
  }]), documents([{
    accountId: 'remote-a',
    createdDate: '2026-06-30',
    fileName: 'June 2026 Statement.pdf',
    links: [
      { link: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-a' },
      { link: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-b' },
    ],
  }]))).toThrow('multiple verified statement links');
});

test('Marcus rejects routing ambiguity rather than mixing remote accounts or statements', () => {
  expect(() => buildMarcusRemoteCatalog([
    { text: 'Online Savings Account **** 1111', remoteKey: 'remote-a' },
    { text: 'Online Savings Account **** 1111', remoteKey: 'remote-b' },
  ], [])).toThrow('ambiguous accounts');

  expect(() => buildMarcusRemoteCatalog([], [
    {
      href: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-a',
      accountText: 'Online Savings Account **** 1111',
      documentText: 'June 1, 2026 Statement',
    },
    {
      href: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-b',
      accountText: 'Online Savings Account **** 1111',
      documentText: 'June 1, 2026 Statement',
    },
  ])).toThrow('multiple documents');
});

test('Marcus maps discovered accounts to exact local identities without account-count assumptions', () => {
  const catalog = buildMarcusRemoteCatalog([
    { text: 'Online Savings Account **** 1111', remoteKey: 'remote-a' },
    { text: 'Online Savings Account **** 2222', remoteKey: 'remote-b' },
    { text: 'High-Yield CD - 3333', remoteKey: 'remote-c' },
  ], []);

  expect(mapMarcusRemoteAccounts(catalog.accounts, [
    plannedSavingsAccount({ accountId: 20, last4: '2222' }),
    plannedSavingsAccount({ accountId: 10, last4: '1111' }),
    plannedSavingsAccount({ accountId: 40, last4: '4444' }),
  ])).toEqual([
    { remote: expect.objectContaining({ kind: 'savings', last4: '2222' }), planned: plannedSavingsAccount({ accountId: 20, last4: '2222' }) },
    { remote: expect.objectContaining({ kind: 'savings', last4: '1111' }), planned: plannedSavingsAccount({ accountId: 10, last4: '1111' }) },
  ]);
});

test('Marcus selects only mapped documents inside each account-specific catch-up window', () => {
  const catalog = buildMarcusRemoteCatalog([], [
    {
      href: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/savings-a-june',
      accountText: 'Online Savings Account **** 1111',
      documentText: 'June 30, 2026 Statement',
    },
    {
      href: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/savings-b-may',
      accountText: 'Online Savings Account **** 2222',
      documentText: 'May 31, 2026 Statement',
    },
    {
      href: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/unmapped-june',
      accountText: 'Online Savings Account **** 3333',
      documentText: 'June 30, 2026 Statement',
    },
  ]);
  const plan = planMarcusCatalog(catalog, [
    plannedSavingsAccount({ accountId: 10, last4: '1111', startDate: '2026-06-01' }),
    plannedSavingsAccount({ accountId: 20, last4: '2222', startDate: '2026-06-01' }),
    plannedSavingsAccount({ accountId: 40, last4: '4444', startDate: '2026-06-01' }),
  ], '2026-06-30');

  expect(plan.mappedAccounts.map(({ planned }) => planned.accountId)).toEqual([10, 20]);
  expect(plan.documents.map(({ document, planned }) => ({
    statementDate: document.statementDate,
    accountId: planned.accountId,
  }))).toEqual([{ statementDate: '2026-06-30', accountId: 10 }]);
  expect(plan.unmappedAccountCount).toBe(1);
  expect(plan.unavailableAccountCount).toBe(1);
});

test('Marcus permits only the verified authenticated document route', () => {
  expect(marcusDocumentRequest('https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/opaque-document')).toEqual({
    method: 'GET',
    url: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/opaque-document',
  });
  expect(() => marcusDocumentRequest('https://example.com/api/v1/accounts/document/opaque-document')).toThrow(
    'destination is invalid',
  );
  expect(() => marcusDocumentRequest('/us/en/login')).toThrow('destination is invalid');
  expect(() => marcusDocumentRequest(
    'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/opaque-document?token=secret',
  )).toThrow('destination is invalid');
});

test('Marcus recognizes only the two observed catalog operation request shapes', () => {
  const request = (overrides: {
    method?: string;
    url?: string;
    postData?: string | null;
  } = {}) => ({
    method: () => overrides.method ?? 'POST',
    url: () => overrides.url ?? 'https://www.marcus.com/api/cos?operations=Catalog',
    postData: () => overrides.postData ?? '{"variables":{"savingsAccountsInput":{}}}',
  });
  expect(isMarcusApiCatalogRequest(request(), 'accounts')).toBe(true);
  expect(isMarcusApiCatalogRequest(request({
    url: 'https://www.marcus.com/api/cos/?operations=Catalog',
  }), 'accounts')).toBe(true);
  expect(isMarcusApiCatalogRequest(request({
    postData: '{"query":"savingsDocumentList"}',
  }), 'documents')).toBe(true);
  expect(isMarcusApiCatalogRequest(request({ method: 'GET' }), 'accounts')).toBe(false);
  expect(isMarcusApiCatalogRequest(request({
    url: 'https://example.com/api/cos?operations=Catalog',
  }), 'accounts')).toBe(false);
  expect(isMarcusApiCatalogRequest(request({
    url: 'https://www.marcus.com/api/cos?operations=Catalog&extra=1',
  }), 'accounts')).toBe(false);
  expect(isMarcusApiCatalogRequest(request({
    url: 'https://www.marcus.com/api/cos//?operations=Catalog',
  }), 'accounts')).toBe(false);
  expect(isMarcusApiCatalogRequest(request({ postData: '{"variables":{}}' }), 'accounts')).toBe(false);
});

test('Marcus parses the observed authenticated API response without a rejected duplicate replay', async () => {
  const response = {
    ok: () => true,
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
    json: async () => ({ data: { safe: true } }),
  } as unknown as Parameters<typeof readMarcusApiPayload>[0];

  await expect(readMarcusApiPayload(response)).resolves.toEqual({ data: { safe: true } });
});

test('Marcus spans observed account and document routes when capturing catalog requests', async () => {
  type ResponseListener = (response: {
    request: () => {
      method: () => string;
      postData: () => string;
      url: () => string;
    };
  }) => void;
  const listeners = new Set<ResponseListener>();
  const navigations: string[] = [];
  let currentUrl = 'https://www.marcus.com/us/en/dashboard';
  const accountsRequest = {
    method: () => 'POST',
    postData: () => JSON.stringify([{ variables: { savingsAccountsInput: {} } }]),
    url: () => 'https://www.marcus.com/api/cos?operations=Accounts',
  };
  const documentsRequest = {
    method: () => 'POST',
    postData: () => JSON.stringify({ query: 'savingsDocumentList' }),
    url: () => 'https://www.marcus.com/api/cos?operations=Documents',
  };
  const accountsResponse = {
    request: () => accountsRequest,
    ok: () => true,
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => [{ data: { savings: { accounts: [{
      accountId: 'remote-a',
      accountNumberLastFour: '1111',
      formattedAccountName: 'Online Savings Account',
    }] } } }],
  };
  const documentsResponse = {
    request: () => documentsRequest,
    ok: () => true,
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => ({ data: { data: { savingsDocumentList: { response: [{
      accountId: 'remote-a',
      createdDate: '2026-06-30T12:00:00Z',
      fileName: 'June 2026 Statement.pdf',
      links: [{ link: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/document-a' }],
    }] } } } }),
  };
  const context = {
    on: (_event: 'response', listener: ResponseListener) => listeners.add(listener),
    off: (_event: 'response', listener: ResponseListener) => listeners.delete(listener),
  };
  const page = {
    url: () => currentUrl,
    goto: async (url: string) => {
      currentUrl = url;
      navigations.push(url);
      const response = url.endsWith('/accounts') ? accountsResponse : documentsResponse;
      for (const listener of listeners) listener(response);
    },
    locator: () => ({ count: async () => 0 }),
    waitForLoadState: async () => {},
    context: () => context,
  } as unknown as Page;

  const catalog = await discoverMarcusRemoteCatalog(page);

  expect(navigations).toEqual([
    'https://www.marcus.com/us/en/accounts',
    'https://www.marcus.com/us/en/documents',
  ]);
  expect(catalog).toMatchObject({
    accounts: [{ kind: 'savings', last4: '1111', availableArtifactCount: 1 }],
    documents: [{ statementDate: '2026-06-30' }],
  });
  expect(listeners.size).toBe(0);
});

test('Marcus authenticated routes exclude login and challenge paths', () => {
  expect(isMarcusAuthenticatedPath('/us/en/accounts/overview')).toBe(true);
  expect(isMarcusAuthenticatedPath('/us/en/documents')).toBe(true);
  expect(isMarcusAuthenticatedPath('/us/en/login')).toBe(false);
  expect(isMarcusAuthenticatedPath('/us/en/accounts/verify-identity')).toBe(false);
});

test('Marcus begins catalog capture without leaving the authentication page', async () => {
  const listeners = new Set<(request: never) => void>();
  const navigations: string[] = [];
  let currentUrl = 'about:blank';
  const context = {
    on: (_event: 'request', listener: (request: never) => void) => listeners.add(listener),
    off: (_event: 'request', listener: (request: never) => void) => listeners.delete(listener),
  };
  const page = {
    url: () => currentUrl,
    goto: async (url: string) => {
      navigations.push(url);
      currentUrl = 'https://www.marcus.com/us/en/login';
    },
    context: () => context,
  } as unknown as Page;

  expect(await executeMarcusBrowser(page, {
    outputDir: '/tmp/marcus-auth-order-test',
    through: '2026-06-30',
    accounts: [plannedSavingsAccount()],
  }, () => {}, fakeParser())).toEqual({
    status: 'login-required',
    action: 'Sign in to Marcus and complete MFA. EasyMoney will continue automatically.',
  });
  expect(navigations).toEqual([]);
  expect(listeners.size).toBe(1);
});

test('Marcus downloads verified document URLs through the authenticated request context', async () => {
  const calls: Array<{ url: string; options: unknown }> = [];
  let disposed = false;
  const page = {
    context: () => ({
      request: {
        fetch: async (url: string, options: unknown) => {
          calls.push({ url, options });
          return {
            ok: () => true,
            status: () => 200,
            headers: () => ({ 'content-type': 'application/pdf' }),
            body: async () => validPdf,
            dispose: async () => { disposed = true; },
          };
        },
      },
    }),
  } as unknown as Page;

  const bytes = await fetchMarcusDocumentBytes(
    page,
    marcusDocumentRequest('https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/opaque-document'),
  );

  expect(bytes).toEqual(validPdf);
  expect(calls).toEqual([{
    url: 'https://prod.savingsexperienceservice.cft.site.gs.com/api/v1/accounts/document/opaque-document',
    options: { method: 'GET', maxRedirects: 5, timeout: 30_000 },
  }]);
  expect(disposed).toBe(true);
});

test('Marcus validates PDF magic and EOF before parser validation', () => {
  expect(() => validateMarcusPdfSignature(validPdf)).not.toThrow();
  expect(() => validateMarcusPdfSignature(new TextEncoder().encode([
    '<html>',
    'not a financial artifact',
    'with enough bytes to pass a size-only check',
    '%%EOF',
  ].join('\n')))).toThrow('signature is invalid');
});

test('Marcus parser validation emits an account-identifiable review artifact', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'marcus-artifact-test-'));
  try {
    const artifact = await validateMarcusStatementArtifact({
      outputDir,
      bytes: validPdf,
      accountId: 10,
      expectedAccount: savingsAccount(),
      expectedStatementDate: '2026-06-01',
    }, fakeParser());

    expect(artifact).toMatchObject({
      fileName: 'marcus-online-savings-1111-2026-06-30-statement.pdf',
      artifactType: 'statement-pdf',
      accountId: 10,
      account: savingsAccount(),
      statementDate: '2026-06-30',
      parserId: 'marcus-statement-pdf',
      transactionCount: 1,
      balanceCount: 1,
    });
    expect(new Uint8Array(await readFile(artifact.path))).toEqual(validPdf);
    expect(await readdir(outputDir)).toEqual([artifact.fileName]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('Marcus rejects parser account mismatches and removes temporary financial files', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'marcus-mismatch-test-'));
  try {
    await expect(validateMarcusStatementArtifact({
      outputDir,
      bytes: validPdf,
      accountId: 20,
      expectedAccount: savingsAccount('2222'),
      expectedStatementDate: '2026-06-01',
    }, fakeParser())).rejects.toThrow('account identity does not match');
    expect(await readdir(outputDir)).toEqual([]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('Marcus rejects parser dates that disagree with remote document metadata', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'marcus-date-mismatch-test-'));
  try {
    await expect(validateMarcusStatementArtifact({
      outputDir,
      bytes: validPdf,
      accountId: 10,
      expectedAccount: savingsAccount(),
      expectedStatementDate: '2026-05-31',
    }, fakeParser())).rejects.toThrow('date does not match');
    expect(await readdir(outputDir)).toEqual([]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('Marcus reports missing auth without launching Chrome', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'marcus-auth-test-'));
  const events: Parameters<NonNullable<Parameters<typeof runMarcusSync>[1]>>[0][] = [];
  let browserRuns = 0;
  const dependencies: MarcusSyncDependencies = {
    hasSavedAuthentication: async () => false,
    runBrowserProgram: (async () => {
      browserRuns += 1;
      return { status: 'error', message: 'must not launch' };
    }) as MarcusSyncDependencies['runBrowserProgram'],
    parser: fakeParser(),
  };
  try {
    expect(await runMarcusSync({
      outputDir,
      through: '2026-06-30',
      accounts: [plannedSavingsAccount()],
    }, event => events.push(event), dependencies)).toEqual({
      status: 'authentication-required',
      reason: 'missing',
      accounts: [],
      artifacts: [],
    });
    expect(browserRuns).toBe(0);
    expect(events.map(event => event.data?.step ?? event.type)).toEqual([
      'check-authentication',
      'check-authentication',
      'warning',
    ]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('Marcus cached-auth probes stay headless when interactive auth is not granted', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'marcus-headless-test-'));
  let browserSession: {
    startUrl: string;
    beforeStartNavigation?: (page: Page) => void | Promise<void>;
    contextOptions?: { headless?: boolean };
  } | undefined;
  let authenticationRecoveryUrl: string | undefined;
  const dependencies: MarcusSyncDependencies = {
    hasSavedAuthentication: async () => true,
    runBrowserProgram: (async (
      session: {
        startUrl: string;
        beforeStartNavigation?: (page: Page) => void | Promise<void>;
        contextOptions?: { headless?: boolean };
      },
      _code: string,
      options: { authenticationRecoveryUrl?: string },
    ) => {
      browserSession = session;
      authenticationRecoveryUrl = options.authenticationRecoveryUrl;
      return { status: 'login-required' };
    }) as MarcusSyncDependencies['runBrowserProgram'],
    parser: fakeParser(),
  };
  try {
    expect(await runMarcusSync({
      outputDir,
      through: '2026-06-30',
      accounts: [plannedSavingsAccount()],
      allowInteractiveAuthentication: false,
    }, undefined, dependencies)).toMatchObject({
      status: 'authentication-required',
      reason: 'expired',
    });
    expect(browserSession?.contextOptions?.headless).toBe(true);
    expect(browserSession?.startUrl).toBe('https://www.marcus.com/us/en/documents');
    expect(browserSession?.beforeStartNavigation).toBeFunction();
    expect(authenticationRecoveryUrl).toBe('https://www.marcus.com/us/en/login');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
