import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright';
import {
  buildMarcusRemoteCatalog,
  fetchMarcusDocumentBytes,
  isMarcusAuthenticatedPath,
  mapMarcusRemoteAccounts,
  marcusAccountIdentityFromText,
  marcusDocumentRequest,
  marcusStatementDateFromText,
  planMarcusCatalog,
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
  expect(marcusStatementDateFromText('June 2026 Statement')).toBe('2026-06-01');
});

test('Marcus discovers every savings and deposit account while selecting every supported document', () => {
  const catalog = buildMarcusRemoteCatalog([
    { text: 'Online Savings Account **** 1111', remoteKey: 'remote-a' },
    { text: 'High-Yield CD - 2222', remoteKey: 'remote-b' },
    { text: 'Online Savings Account **** 1111', remoteKey: 'remote-a' },
  ], [
    {
      href: '/us/en/accounts/document/document-a',
      accountText: 'Online Savings Account **** 1111',
      documentText: 'June 1, 2026 Statement',
      remoteKey: 'remote-a',
    },
    {
      href: '/us/en/accounts/document/document-a',
      accountText: 'Online Savings Account **** 1111',
      documentText: 'June 1, 2026 Statement',
      remoteKey: 'remote-a',
    },
    {
      href: '/us/en/accounts/document/document-b',
      accountText: 'High-Yield CD - 2222',
      documentText: 'June 1, 2026 Statement',
      remoteKey: 'remote-b',
    },
    {
      href: '/us/en/accounts/document/tax-document',
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
    request: { method: 'GET', url: 'https://www.marcus.com/us/en/accounts/document/document-a' },
  });
  expect(catalog.unsupportedArtifactCount).toBe(2);
});

test('Marcus rejects routing ambiguity rather than mixing remote accounts or statements', () => {
  expect(() => buildMarcusRemoteCatalog([
    { text: 'Online Savings Account **** 1111', remoteKey: 'remote-a' },
    { text: 'Online Savings Account **** 1111', remoteKey: 'remote-b' },
  ], [])).toThrow('ambiguous accounts');

  expect(() => buildMarcusRemoteCatalog([], [
    {
      href: '/us/en/accounts/document/document-a',
      accountText: 'Online Savings Account **** 1111',
      documentText: 'June 1, 2026 Statement',
    },
    {
      href: '/us/en/accounts/document/document-b',
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
      href: '/us/en/accounts/document/savings-a-june',
      accountText: 'Online Savings Account **** 1111',
      documentText: 'June 30, 2026 Statement',
    },
    {
      href: '/us/en/accounts/document/savings-b-may',
      accountText: 'Online Savings Account **** 2222',
      documentText: 'May 31, 2026 Statement',
    },
    {
      href: '/us/en/accounts/document/unmapped-june',
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
  expect(marcusDocumentRequest('/us/en/accounts/document/opaque-document')).toEqual({
    method: 'GET',
    url: 'https://www.marcus.com/us/en/accounts/document/opaque-document',
  });
  expect(() => marcusDocumentRequest('https://example.com/us/en/accounts/document/opaque-document')).toThrow(
    'destination is invalid',
  );
  expect(() => marcusDocumentRequest('/us/en/login')).toThrow('destination is invalid');
});

test('Marcus authenticated routes exclude login and challenge paths', () => {
  expect(isMarcusAuthenticatedPath('/us/en/accounts/overview')).toBe(true);
  expect(isMarcusAuthenticatedPath('/us/en/documents')).toBe(true);
  expect(isMarcusAuthenticatedPath('/us/en/login')).toBe(false);
  expect(isMarcusAuthenticatedPath('/us/en/accounts/verify-identity')).toBe(false);
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
    marcusDocumentRequest('/us/en/accounts/document/opaque-document'),
  );

  expect(bytes).toEqual(validPdf);
  expect(calls).toEqual([{
    url: 'https://www.marcus.com/us/en/accounts/document/opaque-document',
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
  let browserSession: { contextOptions?: { headless?: boolean } } | undefined;
  const dependencies: MarcusSyncDependencies = {
    hasSavedAuthentication: async () => true,
    runBrowserProgram: (async (session: { contextOptions?: { headless?: boolean } }) => {
      browserSession = session;
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
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
