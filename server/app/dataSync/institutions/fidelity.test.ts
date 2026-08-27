import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Download } from 'playwright';

import {
  FIDELITY_AUTHENTICATION_TIMEOUT_MS,
  assertFidelityActivityHistoryRequest,
  assertFidelityActivityResponseAccount,
  assertFidelityStatementControlBijection,
  assertUniqueFidelityRoutingSuffixes,
  decodeFidelityStatementDocument,
  fidelityAccountsFromCandidates,
  fidelityArtifactDedupeKey,
  fidelityArtifactFileName,
  fidelityBrowserFetchInPage,
  fidelityDirectRequestUrl,
  fidelityStatementDocumentIdFromRequestBody,
  fidelityResponseRequiresAuthentication,
  fidelityStatementYearTraversal,
  filterFidelityRetailActivityAccounts,
  isFidelityAuthenticatedPage,
  isFidelityActivityHistoryRequestUrl,
  isFidelityInstitutionUnavailableText,
  isFidelityRetailActivityUrl,
  isFidelityStatementDownloadRequestUrl,
  isFidelityStatementListRequestUrl,
  navigateToFidelityPage,
  parseFidelityStatementList,
  resolveFidelitySurfaceDiscoveries,
  saveAndValidateFidelityBrowserDownload,
  traverseFidelityStatementYears,
  validateFidelityArtifact,
  verifyFidelityActivityAccounts,
  type FidelityAccountIdentity,
  type FidelityDownloadedArtifact,
  type FidelityRemoteAccount,
} from './fidelity.ts';

test('Fidelity interactive authentication allows a full user login and MFA window', async () => {
  expect(FIDELITY_AUTHENTICATION_TIMEOUT_MS).toBe(30 * 60_000);

  const source = await readFile(new URL('./fidelity.ts', import.meta.url), 'utf8');
  const runStart = source.indexOf('export async function runFidelitySync');
  const runSource = source.slice(runStart);
  expect(runSource).toContain(
    'authenticationTimeoutMs: FIDELITY_AUTHENTICATION_TIMEOUT_MS',
  );
});

const retailAccount: FidelityAccountIdentity = {
  surface: 'retail',
  kind: 'brokerage',
  accountKey: 'retail-account',
  remoteAccountId: 'fidelity:Z00001234',
  last4: '1234',
};

function remoteAccount(
  surface: FidelityRemoteAccount['surface'],
  accountKey: string,
): FidelityRemoteAccount {
  return {
    surface,
    kind: surface === 'retail' ? 'brokerage' : 'retirement',
    accountKey,
    remoteAccountId: surface === 'retail'
      ? 'fidelity:Z00001234'
      : 'fidelity:netbenefits:workplace-one',
    siteAccountId: surface === 'retail' ? 'Z00001234' : 'workplace-one',
    last4: surface === 'retail' ? '1234' : '5678',
    label: surface === 'retail' ? 'Brokerage 1234' : 'Workplace plan 5678',
    selection: {
      controlIndex: 0,
      href: null,
      label: surface === 'retail' ? 'Brokerage 1234' : 'Workplace plan 5678',
    },
  };
}

describe('Fidelity account discovery', () => {
  test('discovers every supported account candidate dynamically', () => {
    const accounts = fidelityAccountsFromCandidates([
      {
        surface: 'retail',
        label: 'Individual brokerage - 1234 $10,000.00',
        remoteId: 'retail-one',
      },
      {
        surface: 'retail',
        label: 'Cash Management Account - 5678 $500.00',
        value: 'retail-two',
      },
      {
        surface: 'netbenefits',
        label: 'Example 401(k) Savings Plan 9012',
        href: 'https://nb.fidelity.com/mybenefits/navigation/plan?planId=workplace-one',
      },
      {
        surface: 'retail',
        label: 'Select an account',
      },
    ]);

    expect(accounts).toHaveLength(3);
    expect(accounts.map(account => ({
      surface: account.surface,
      kind: account.kind,
      last4: account.last4,
      label: account.selection.label,
    }))).toEqual([
      {
        surface: 'retail',
        kind: 'brokerage',
        last4: '1234',
        label: 'Individual brokerage - 1234',
      },
      {
        surface: 'retail',
        kind: 'cash-management',
        last4: '5678',
        label: 'Cash Management Account - 5678',
      },
      {
        surface: 'netbenefits',
        kind: 'retirement',
        last4: '9012',
        label: 'Example 401(k) Savings Plan 9012',
      },
    ]);
  });

  test('keeps exact activity identities distinct even when display suffixes match', async () => {
    const accounts = fidelityAccountsFromCandidates([
      { surface: 'retail', label: 'Brokerage 1234', remoteId: 'first' },
      { surface: 'retail', label: 'Roth IRA 1234', remoteId: 'second' },
    ]);
    await expect(filterFidelityRetailActivityAccounts(accounts, async () => true))
      .resolves.toHaveLength(2);
    await expect(filterFidelityRetailActivityAccounts(accounts, async account => account.kind !== 'ira'))
      .resolves.toHaveLength(1);
  });

  test('uses exact-identity keys to keep same-kind same-suffix activity files distinct', () => {
    const accounts = fidelityAccountsFromCandidates([
      { surface: 'retail', label: 'Brokerage 1111', remoteId: 'Z00001111' },
      { surface: 'retail', label: 'Brokerage 1111', remoteId: 'Y00001111' },
    ]);
    const fileNames = accounts.map(account => fidelityArtifactFileName(
      account,
      'activity-json',
      '2026-07-01',
      '2026-07-31',
    ));

    expect(accounts.map(account => account.kind)).toEqual(['brokerage', 'brokerage']);
    expect(accounts.map(account => account.last4)).toEqual(['1111', '1111']);
    expect(new Set(fileNames).size).toBe(2);
    expect(fileNames.every((fileName, index) => fileName.includes(accounts[index]!.accountKey))).toBe(true);
  });

  test('deduplicates only semantically identical responsive account controls', () => {
    expect(fidelityAccountsFromCandidates([
      { surface: 'retail', label: 'Brokerage 1234', remoteId: 'same', controlIndex: 0 },
      { surface: 'retail', label: ' Brokerage 1234 ', remoteId: 'same', controlIndex: 1 },
    ])).toHaveLength(1);
    expect(() => fidelityAccountsFromCandidates([
      { surface: 'retail', label: 'Brokerage 1234', remoteId: 'same' },
      { surface: 'retail', label: 'Brokerage 5678', remoteId: 'same' },
    ])).toThrow('conflicting account identity');
    expect(() => assertUniqueFidelityRoutingSuffixes(fidelityAccountsFromCandidates([
      { surface: 'retail', label: 'Brokerage 1234', remoteId: 'first' },
      { surface: 'retail', label: 'Roth IRA 1234', remoteId: 'second' },
    ]))).not.toThrow();
  });

  test('keeps only dynamically proven retail activity accounts', async () => {
    const accounts = fidelityAccountsFromCandidates([
      { surface: 'retail', label: 'Brokerage 1234', remoteId: 'retail-one' },
      { surface: 'retail', label: 'Roth IRA 5678', remoteId: 'retail-two' },
      { surface: 'retail', label: 'Stock Plan 9012', remoteId: 'workplace-one' },
    ]);
    const checked: string[] = [];

    const supported = await filterFidelityRetailActivityAccounts(accounts, async account => {
      checked.push(account.accountKey);
      return account.kind !== 'stock-plan';
    });

    expect(checked).toEqual(accounts.map(account => account.accountKey));
    expect(supported.map(account => account.kind)).toEqual(['brokerage', 'ira']);
  });

  test('recognizes only the Fidelity retail activity route as activity-capable', () => {
    expect(isFidelityRetailActivityUrl(
      'https://digital.fidelity.com/ftgw/digital/portfolio/activity',
    )).toBe(true);
    expect(isFidelityRetailActivityUrl(
      'https://digital.fidelity.com/ftgw/digital/portfolio/summary',
    )).toBe(false);
    expect(isFidelityRetailActivityUrl(
      'https://nb.fidelity.com/public/nb/default/home',
    )).toBe(false);
  });

  test('classifies an event-driven redirect away from activity as unsupported instead of expired auth', async () => {
    let currentUrl = 'https://digital.fidelity.com/ftgw/digital/portfolio/activity';
    const page = {
      url: () => currentUrl,
      goto: async () => null,
      locator: (selector: string) => selector.includes('password')
        ? { count: async () => 0 }
        : { first: () => ({ waitFor: () => new Promise<void>(() => {}) }) },
      getByText: () => ({ count: async () => 0 }),
      waitForURL: async (predicate: (url: URL) => boolean) => {
        const unsupported = new URL('https://digital.fidelity.com/ftgw/digital/stock-plan/overview');
        expect(predicate(unsupported)).toBe(true);
        currentUrl = unsupported.toString();
      },
    } as never;

    await expect(navigateToFidelityPage(
      page,
      'https://digital.fidelity.com/ftgw/digital/portfolio/activity',
      '#account-selector',
      { missingControlsMeanNoAccounts: true },
    )).resolves.toBe('no-accounts');
  });

  test('continues with retail accounts when NetBenefits has no accounts', () => {
    const retail = remoteAccount('retail', 'retail-one');
    expect(resolveFidelitySurfaceDiscoveries([
      { surface: 'retail', status: 'accounts', accounts: [retail] },
      { surface: 'netbenefits', status: 'no-accounts', accounts: [] },
    ])).toEqual({
      retailAccounts: [retail],
      netBenefitsAccounts: [],
      skipped: ['Fidelity NetBenefits has no accounts'],
    });
  });

  test('continues with workplace accounts when retail is unavailable to the login', () => {
    const workplace = remoteAccount('netbenefits', 'workplace-one');
    expect(resolveFidelitySurfaceDiscoveries([
      { surface: 'retail', status: 'authentication-required', accounts: [] },
      { surface: 'netbenefits', status: 'accounts', accounts: [workplace] },
    ])).toEqual({
      retailAccounts: [],
      netBenefitsAccounts: [workplace],
      skipped: [
        'Fidelity retail is not available to this login',
        'Fidelity NetBenefits accounts were discovered, but their downloads are not yet parser-verified',
      ],
    });
  });

  test('keeps parser-verified retail work when unsupported NetBenefits accounts are also discovered', () => {
    const retail = remoteAccount('retail', 'retail-one');
    const workplace = remoteAccount('netbenefits', 'workplace-one');
    expect(resolveFidelitySurfaceDiscoveries([
      { surface: 'retail', status: 'accounts', accounts: [retail] },
      { surface: 'netbenefits', status: 'accounts', accounts: [workplace] },
    ])).toEqual({
      retailAccounts: [retail],
      netBenefitsAccounts: [workplace],
      skipped: ['Fidelity NetBenefits accounts were discovered, but their downloads are not yet parser-verified'],
    });
  });

  test('requires login only when both surfaces require authentication', () => {
    expect(() => resolveFidelitySurfaceDiscoveries([
      { surface: 'retail', status: 'authentication-required', accounts: [] },
      { surface: 'netbenefits', status: 'authentication-required', accounts: [] },
    ])).toThrow('authentication-required');
  });

  test('requires login when an expired retail surface is paired with a public NetBenefits landing page', async () => {
    const publicLanding = {
      url: () => 'https://nb.fidelity.com/public/nb/default/home',
      getByText: () => ({ count: async () => 0 }),
      locator: () => ({ count: async () => 0 }),
    } as never;
    expect(await isFidelityAuthenticatedPage(publicLanding)).toBe(false);
    expect(() => resolveFidelitySurfaceDiscoveries([
      { surface: 'retail', status: 'authentication-required', accounts: [] },
      { surface: 'netbenefits', status: 'no-accounts', accounts: [] },
    ])).toThrow('authentication-required');
  });

  test('reports institution-wide maintenance only when both surfaces are unavailable', () => {
    expect(() => resolveFidelitySurfaceDiscoveries([
      { surface: 'retail', status: 'institution-unavailable', accounts: [] },
      { surface: 'netbenefits', status: 'institution-unavailable', accounts: [] },
    ])).toThrow('institution-unavailable');
  });
});

describe('Fidelity direct requests', () => {
  test('accepts Fidelity HTTPS destinations and strips fragments', () => {
    expect(fidelityDirectRequestUrl('/documents/report.pdf#page=1')).toBe(
      'https://www.fidelity.com/documents/report.pdf',
    );
    expect(fidelityDirectRequestUrl('https://digital.fidelity.com/download/activity.csv')).toBe(
      'https://digital.fidelity.com/download/activity.csv',
    );
  });

  test('rejects non-Fidelity and non-HTTPS destinations', () => {
    expect(() => fidelityDirectRequestUrl('https://example.com/report.pdf')).toThrow(
      'Fidelity direct request destination is not trusted',
    );
    expect(() => fidelityDirectRequestUrl('http://www.fidelity.com/report.pdf')).toThrow(
      'Fidelity direct request destination is not trusted',
    );
  });
});

describe('Fidelity statement contracts', () => {
  test('binds the activity history request to the exact endpoint, selected account, and dates', () => {
    const url = 'https://digital.fidelity.com/ftgw/digital/activityapi/api/v1/transactions/history';
    const body = {
      filter: {
        accounts: [{ acctNum: 'Z00001234', acctName: 'Example brokerage', acctType: 'BROKERAGE' }],
        searchCriteriaDetail: {
          txnFromDate: Date.parse('2026-07-01T04:00:00.000Z') / 1_000,
          txnToDate: Date.parse('2026-07-31T04:00:00.000Z') / 1_000,
          includeBasketNames: true,
          includeCoreFundSettlementTransactions: false,
        },
      },
    };
    const request = { url, method: 'POST', postData: JSON.stringify(body) };
    const expected = { siteAccountId: 'Z00001234', from: '2026-07-01', through: '2026-07-31' };

    expect(isFidelityActivityHistoryRequestUrl(url)).toBe(true);
    expect(() => assertFidelityActivityHistoryRequest(request, expected)).not.toThrow();
    expect(() => assertFidelityActivityHistoryRequest({
      ...request,
      url: `${url}?account=Z00001234`,
    }, expected)).toThrow('endpoint is invalid');
    expect(() => assertFidelityActivityHistoryRequest({
      ...request,
      url: 'https://example.com/transactions/history',
    }, expected)).toThrow('endpoint is invalid');
    expect(() => assertFidelityActivityHistoryRequest({
      ...request,
      url: 'https://digital.fidelity.com/another/api/transactions/history',
    }, expected)).toThrow('endpoint is invalid');
    expect(() => assertFidelityActivityHistoryRequest({
      ...request,
      url: 'https://www.fidelity.com/ftgw/digital/activityapi/api/v1/transactions/history',
    }, expected)).toThrow('endpoint is invalid');
    expect(() => assertFidelityActivityHistoryRequest({ ...request, method: 'GET' }, expected))
      .toThrow('endpoint is invalid');
    expect(() => assertFidelityActivityHistoryRequest({
      ...request,
      postData: JSON.stringify({
        ...body,
        filter: { ...body.filter, accounts: [{ ...body.filter.accounts[0], acctNum: 'Z00005678' }] },
      }),
    }, expected)).toThrow('does not match');
    expect(() => assertFidelityActivityHistoryRequest(request, { ...expected, from: '2026-07-02' }))
      .toThrow('does not match');
    expect(() => assertFidelityActivityHistoryRequest({
      ...request,
      postData: JSON.stringify({
        ...body,
        filter: {
          ...body.filter,
          searchCriteriaDetail: {
            ...body.filter.searchCriteriaDetail,
            txnFromDate: Date.parse('2026-07-01T00:00:00.000Z') / 1_000,
          },
        },
      }),
    }, expected)).toThrow('does not match');

    expect(() => assertFidelityActivityHistoryRequest({
      ...request,
      postData: JSON.stringify({
        ...body,
        filter: {
          ...body.filter,
          searchCriteriaDetail: {
            ...body.filter.searchCriteriaDetail,
            txnFromDate: Date.parse('2026-01-01T05:00:00.000Z') / 1_000,
            txnToDate: Date.parse('2026-01-31T05:00:00.000Z') / 1_000,
          },
        },
      }),
    }, { ...expected, from: '2026-01-01', through: '2026-01-31' })).not.toThrow();
  });

  test('requires every API activity row to match the exact selected raw and canonical account identity', () => {
    const transaction = {
      acctNum: 'Z00001234',
      date: Date.parse('2026-07-15T00:00:00.000Z') / 1_000,
      amtDetail: { net: 12.34 },
      description: 'Example activity',
    };
    const bytes = new TextEncoder().encode(JSON.stringify({
      errors: [],
      data: { transactions: [transaction] },
    }));
    const expected = { siteAccountId: 'Z00001234', remoteAccountId: 'fidelity:Z00001234' };
    expect(() => assertFidelityActivityResponseAccount(bytes, expected)).not.toThrow();
    expect(() => assertFidelityActivityResponseAccount(new TextEncoder().encode(JSON.stringify({
      errors: [],
      data: { transactions: [transaction, { ...transaction, acctNum: 'Z00005678' }] },
    })), expected)).toThrow('does not match');
    expect(() => assertFidelityActivityResponseAccount(new TextEncoder().encode(JSON.stringify({
      errors: [],
      data: { transactions: [{ ...transaction, acctNum: 'Z00-001234' }] },
    })), expected)).toThrow('does not match');
  });

  test('parses exact account and document identities from statement list metadata', () => {
    expect(parseFidelityStatementList({
      statement: {
        docDetails: {
          docDetail: [{
            id: 'document-one',
            acctNum: 'Z00-000000',
            periodStartDate: Date.UTC(2026, 6, 1),
            periodEndDate: Date.UTC(2026, 6, 31),
            generatedDate: Date.UTC(2026, 7, 1),
            isHouseholded: false,
            formatTypes: { formatType: { isPDF: true, isHTML: false, isCSV: false } },
          }],
        },
      },
    })).toEqual([{
      id: 'document-one',
      remoteAccountId: 'fidelity:Z00000000',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      pdfAvailable: true,
      householded: false,
    }]);
    expect(() => parseFidelityStatementList({ statement: { docDetails: { docDetail: [
      { id: 'same', acctNum: 'Z00-000000', formatTypes: { formatType: { isPDF: true } } },
      { id: 'same', acctNum: 'Z00-000001', formatTypes: { formatType: { isPDF: true } } },
    ] } } })).toThrow('ambiguous');
  });

  test('binds each discovered account to one unique activity parser claim', () => {
    const account = remoteAccount('retail', 'retail-one');
    const artifact: FidelityDownloadedArtifact = {
      artifactType: 'activity-csv',
      fileName: 'activity.csv',
      account,
      coveredFrom: '2026-07-01',
      coveredThrough: '2026-07-31',
      path: '/tmp/activity.csv',
      parserId: 'fidelity-activity-csv',
      transactionCount: 1,
      balanceCount: 0,
      contentHash: 'a'.repeat(64),
      sourceAccounts: [{
        remoteAccountId: 'fidelity:Z00001234',
        sourceAccountName: 'Example Brokerage',
      }],
    };
    expect(verifyFidelityActivityAccounts([artifact], [account])).toEqual([{
      account,
      sourceAccount: artifact.sourceAccounts[0],
    }]);
    expect(() => verifyFidelityActivityAccounts([
      artifact,
      { ...artifact, account: { ...account, accountKey: 'retail-two' }, fileName: 'second.csv' },
    ], [account, { ...account, accountKey: 'retail-two' }])).toThrow('same parser identity');
    expect(() => verifyFidelityActivityAccounts([
      { ...artifact, sourceAccounts: [{
        remoteAccountId: 'fidelity:Z00005678',
        sourceAccountName: 'Example Brokerage',
      }] },
    ], [account])).toThrow('does not match the selected account');
  });

  test('retains account traversal proof for an official empty activity export', () => {
    const account = remoteAccount('retail', 'retail-one');
    const emptyArtifact: FidelityDownloadedArtifact = {
      artifactType: 'activity-csv',
      fileName: 'empty.csv',
      account,
      coveredFrom: '2026-07-01',
      coveredThrough: '2026-07-31',
      path: '/tmp/empty.csv',
      parserId: 'fidelity-activity-csv',
      transactionCount: 0,
      balanceCount: 0,
      contentHash: 'e'.repeat(64),
      sourceAccounts: [],
    };
    expect(verifyFidelityActivityAccounts([emptyArtifact], [account])).toEqual([]);
  });

  test('recognizes list/download endpoints and validates exact download POST metadata', () => {
    expect(isFidelityStatementListRequestUrl(
      'https://digital.fidelity.com/ftgw/dp/retail-am-financialdoc/v1/accounts/communications/financial-documents/statements',
    )).toBe(true);
    expect(isFidelityStatementDownloadRequestUrl(
      'https://digital.fidelity.com/ftgw/dp/retail-am-financialdoc/v1/accounts/communications/financial-documents/download',
    )).toBe(true);
    expect(isFidelityStatementDownloadRequestUrl(
      'https://example.com/accounts/communications/financial-documents/download',
    )).toBe(false);
    expect(fidelityStatementDocumentIdFromRequestBody(JSON.stringify({
      acctType: 'account',
      docType: 'statement',
      formatType: 'PDF',
      id: 'document-one',
    }))).toBe('document-one');
    expect(() => fidelityStatementDocumentIdFromRequestBody('{}')).toThrow('metadata is missing');

    const pdf = Buffer.from('%PDF-1.4\nexample');
    expect(decodeFidelityStatementDocument({
      document: {
        docDetail: {
          content: pdf.toString('base64'),
          contentType: 'application/pdf',
          encoding: 'base64',
        },
      },
    })).toEqual(new Uint8Array(pdf));
    expect(() => decodeFidelityStatementDocument({ document: {} })).toThrow(
      'Fidelity statement response metadata is missing',
    );
  });

  test('deduplicates only exact content, parser identity, source identities, and coverage', () => {
    const account = remoteAccount('retail', 'retail-one');
    const artifact: FidelityDownloadedArtifact = {
      artifactType: 'statement-pdf',
      fileName: 'first.pdf',
      account,
      coveredFrom: '2026-07-01',
      coveredThrough: '2026-07-31',
      path: '/tmp/first.pdf',
      parserId: 'fidelity-investment-report-pdf',
      transactionCount: 1,
      balanceCount: 1,
      contentHash: 'b'.repeat(64),
      sourceAccounts: [{
        remoteAccountId: 'fidelity:Z00000000',
        sourceAccountName: 'Z00-000000',
      }],
    };
    expect(fidelityArtifactDedupeKey({ ...artifact, fileName: 'responsive-copy.pdf' }))
      .toBe(fidelityArtifactDedupeKey(artifact));
    expect(fidelityArtifactDedupeKey({ ...artifact, contentHash: 'c'.repeat(64) }))
      .not.toBe(fidelityArtifactDedupeKey(artifact));
  });

  test('requires an exact bijection between statement list identities and download controls', () => {
    const documents = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
    expect(() => assertFidelityStatementControlBijection(documents, ['three', 'one', 'two']))
      .not.toThrow();
    expect(() => assertFidelityStatementControlBijection(documents, ['one', 'one', 'two']))
      .toThrow('do not match list metadata exactly');
    expect(() => assertFidelityStatementControlBijection(documents, ['one', 'two']))
      .toThrow('do not match list metadata exactly');
    expect(() => assertFidelityStatementControlBijection(documents, ['one', 'two', 'three', 'four']))
      .toThrow('do not match list metadata exactly');
  });

  test('processes the initially rendered year first, then reselects every other available requested year', async () => {
    expect(fidelityStatementYearTraversal(
      ['2024', '2025', '2026'],
      [{ year: '2025', selected: false }, { year: '2026', selected: true }],
    )).toEqual({
      orderedYears: ['2026', '2025'],
      missingYears: ['2024'],
      useInitialView: false,
    });

    const events: string[] = [];
    const traversal = await traverseFidelityStatementYears({
      initialView: 'view-2026',
      requestedYears: ['2024', '2025', '2026'],
      initialOptions: [{ year: '2025', selected: false }, { year: '2026', selected: true }],
      selectYear: async year => {
        events.push(`select-${year}`);
        return `view-${year}`;
      },
      processView: async view => {
        events.push(`process-${view}`);
      },
    });
    expect(events).toEqual(['process-view-2026', 'select-2025', 'process-view-2025']);
    expect(traversal.missingYears).toEqual(['2024']);
  });

  test('falls back to the current statement view only when no requested year is available', async () => {
    const views: string[] = [];
    await traverseFidelityStatementYears({
      initialView: 'current-view',
      requestedYears: ['2024'],
      initialOptions: [{ year: '2025', selected: true }, { year: '2026', selected: false }],
      selectYear: async () => { throw new Error('must not select an unavailable year'); },
      processView: async view => { views.push(view); },
    });
    expect(views).toEqual(['current-view']);
  });
});

describe('Fidelity replay authentication', () => {
  test('classifies status, redirect, final login URL, and login HTML as expired authentication', () => {
    expect(fidelityResponseRequiresAuthentication({
      status: 401,
      url: 'https://digital.fidelity.com/api/activity',
    })).toBe(true);
    expect(fidelityResponseRequiresAuthentication({
      status: 403,
      url: 'https://digital.fidelity.com/api/activity',
    })).toBe(true);
    expect(fidelityResponseRequiresAuthentication({
      status: 302,
      url: 'https://digital.fidelity.com/api/activity',
      headers: { location: 'https://digital.fidelity.com/prgw/digital/login/full-page' },
    })).toBe(true);
    expect(fidelityResponseRequiresAuthentication({
      status: 200,
      url: 'https://digital.fidelity.com/prgw/digital/login/full-page',
    })).toBe(true);
    expect(fidelityResponseRequiresAuthentication({
      status: 200,
      url: 'https://digital.fidelity.com/api/activity',
      headers: { 'content-type': 'text/html' },
      bodyText: '<form><input type="password" name="password"></form>',
    })).toBe(true);
    expect(fidelityResponseRequiresAuthentication({
      status: 200,
      url: 'https://digital.fidelity.com/api/activity',
      headers: { 'content-type': 'text/csv' },
      bodyText: 'Run Date,Account,Amount',
    })).toBe(false);
    expect(fidelityResponseRequiresAuthentication({
      status: 0,
      url: 'https://digital.fidelity.com/api/activity',
      redirected: true,
    })).toBe(true);
  });

  test('replays JSON, binary POST bytes, and cookies in Chromium without Bun parsing the HTTP response', async () => {
    const responseBytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const requestBytes = new Uint8Array([255, 0, 42, 128]);
    const jsonResponseBytes = new TextEncoder().encode(JSON.stringify({ result: 'browser-owned' }));
    let observedRequest: {
      method: string;
      contentType: string | null;
      proofHeader: string | null;
      referrer: string | null;
      body: Uint8Array;
    } | null = null;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/replay') {
          observedRequest = {
            method: request.method,
            contentType: request.headers.get('content-type'),
            proofHeader: request.headers.get('x-replay-proof'),
            referrer: request.headers.get('referer'),
            body: new Uint8Array(await request.arrayBuffer()),
          };
          return new Response(responseBytes, {
            headers: {
              'content-type': 'application/octet-stream',
              'set-cookie': 'fidelity-browser-cookie=accepted; Path=/; SameSite=Lax',
            },
          });
        }
        if (url.pathname === '/json') {
          return new Response(jsonResponseBytes, {
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.pathname === '/redirect') {
          return new Response(null, {
            status: 302,
            headers: {
              location: '/login',
              'set-cookie': 'fidelity-redirect-cookie=accepted; Path=/; SameSite=Lax',
            },
          });
        }
        return new Response('<!doctype html><title>Fidelity browser replay test</title>', {
          headers: { 'content-type': 'text/html' },
        });
      },
    });
    const origin = server.url.origin;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      const response = await page.evaluate(fidelityBrowserFetchInPage, {
        url: `${origin}/replay`,
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          referer: `${origin}/activity`,
          'x-replay-proof': 'preserved',
        },
        bodyBase64: Buffer.from(requestBytes).toString('base64'),
      });

      expect(observedRequest as unknown).toEqual({
        method: 'POST',
        contentType: 'application/octet-stream',
        proofHeader: 'preserved',
        referrer: `${origin}/activity`,
        body: requestBytes,
      });
      expect(response).toMatchObject({
        status: 200,
        url: `${origin}/replay`,
        redirected: false,
      });
      expect(response.headers['content-type']).toContain('application/octet-stream');
      expect(new Uint8Array(Buffer.from(response.bodyBase64, 'base64'))).toEqual(responseBytes);
      expect((await context.cookies(origin)).some(cookie => (
        cookie.name === 'fidelity-browser-cookie' && cookie.value === 'accepted'
      ))).toBe(true);

      const jsonResponse = await page.evaluate(fidelityBrowserFetchInPage, {
        url: `${origin}/json`,
        method: 'GET',
      });
      const receivedJsonBytes = new Uint8Array(Buffer.from(jsonResponse.bodyBase64, 'base64'));
      expect(jsonResponse.headers['content-type']).toContain('application/json');
      expect(receivedJsonBytes).toEqual(jsonResponseBytes);
      expect(JSON.parse(new TextDecoder().decode(receivedJsonBytes))).toEqual({ result: 'browser-owned' });

      const redirect = await page.evaluate(fidelityBrowserFetchInPage, {
        url: `${origin}/redirect`,
        method: 'GET',
      });
      expect(redirect.status).toBe(0);
      expect(redirect.redirected).toBe(true);
      expect(fidelityResponseRequiresAuthentication(redirect)).toBe(true);
      expect((await context.cookies(origin)).some(cookie => (
        cookie.name === 'fidelity-redirect-cookie' && cookie.value === 'accepted'
      ))).toBe(true);
    } finally {
      await browser.close();
      await server.stop(true);
    }
  }, 30_000);
});

describe('Fidelity artifact validation', () => {
  test('validates raw activity JSON with exact parser-backed account identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'easymoney-fidelity-json-test-'));
    const fileName = fidelityArtifactFileName(retailAccount, 'activity-json', '2026-07-01', '2026-07-31');
    const path = join(directory, fileName);
    await writeFile(path, JSON.stringify({
      errors: [],
      data: {
        transactions: [{
          acctNum: 'Z00001234',
          date: Date.parse('2026-07-15T00:00:00.000Z') / 1_000,
          amtDetail: { net: 12.34 },
          description: 'Example activity',
        }],
      },
    }));

    try {
      await expect(validateFidelityArtifact(path, {
        artifactType: 'activity-json',
        fileName,
        account: retailAccount,
        coveredFrom: '2026-07-01',
        coveredThrough: '2026-07-31',
      })).resolves.toMatchObject({
        parserId: 'fidelity-activity-api-json',
        transactionCount: 1,
        balanceCount: 0,
        sourceAccounts: [{
          remoteAccountId: 'fidelity:Z00001234',
          sourceAccountName: 'Fidelity account ending in 1234',
        }],
        coveredFrom: '2026-07-01',
        coveredThrough: '2026-07-31',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('validates a downloaded activity CSV with the Fidelity parser', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'easymoney-fidelity-test-'));
    await mkdir(directory, { recursive: true });
    const fileName = fidelityArtifactFileName(retailAccount, 'activity-csv', '2026-07-01', '2026-07-31');
    const path = join(directory, fileName);
    await writeFile(path, [
      'Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date',
      '07/15/2026,Example Brokerage,Z00-000000,DIVIDEND RECEIVED,EXAMPLE,EXAMPLE FUND,Cash,0,0,0,0,0,12.34,07/15/2026',
    ].join('\n'));

    try {
      const validation = await validateFidelityArtifact(path, {
        artifactType: 'activity-csv',
        fileName,
        account: retailAccount,
        coveredFrom: '2026-07-01',
        coveredThrough: '2026-07-31',
      });
      expect(validation.parserId).toBe('fidelity-activity-csv');
      expect(validation.transactionCount).toBe(1);
      expect(validation.sourceAccounts).toEqual([{
        remoteAccountId: 'fidelity:Z00000000',
        sourceAccountName: 'Example Brokerage',
      }]);
      expect(validation.contentHash).toHaveLength(64);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('parser-validates an official zero-activity schema without inventing a financial fact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'easymoney-fidelity-empty-test-'));
    const fileName = fidelityArtifactFileName(retailAccount, 'activity-csv', '2026-07-01', '2026-07-31');
    const path = join(directory, fileName);
    await writeFile(path, [
      '\uFEFF',
      '',
      'Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date',
    ].join('\n'));

    try {
      await expect(validateFidelityArtifact(path, {
        artifactType: 'activity-csv',
        fileName,
        account: retailAccount,
        coveredFrom: '2026-07-01',
        coveredThrough: '2026-07-31',
      })).resolves.toMatchObject({
        parserId: 'fidelity-activity-csv',
        transactionCount: 0,
        balanceCount: 0,
        sourceAccounts: [],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects an artifact when any parsed fact lacks the stable Fidelity account identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'easymoney-fidelity-incomplete-identity-test-'));
    const fileName = fidelityArtifactFileName(retailAccount, 'activity-csv', '2026-07-01', '2026-07-31');
    const path = join(directory, fileName);
    await writeFile(path, [
      'Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date',
      '07/15/2026,Example Brokerage,Z00-000000,DIVIDEND RECEIVED,EXAMPLE,EXAMPLE FUND,Cash,0,0,0,0,0,12.34,07/15/2026',
      '07/16/2026,,,DIVIDEND RECEIVED,EXAMPLE,EXAMPLE FUND,Cash,0,0,0,0,0,5.00,07/16/2026',
    ].join('\n'));

    try {
      await expect(validateFidelityArtifact(path, {
        artifactType: 'activity-csv',
        fileName,
        account: retailAccount,
        coveredFrom: '2026-07-01',
        coveredThrough: '2026-07-31',
      })).rejects.toThrow('missing a stable account identity');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('saves and parser-validates an official browser-generated activity CSV', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'easymoney-fidelity-browser-download-test-'));
    const fileName = fidelityArtifactFileName(retailAccount, 'activity-csv', '2026-07-01', '2026-07-31');
    const csv = [
      'Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date',
      '07/15/2026,Example Brokerage,Z00-000000,DIVIDEND RECEIVED,EXAMPLE,EXAMPLE FUND,Cash,0,0,0,0,0,12.34,07/15/2026',
    ].join('\n');
    let cancelCalls = 0;
    const download = {
      saveAs: async (path: string) => writeFile(path, csv),
      cancel: async () => {
        cancelCalls += 1;
      },
    } as unknown as Pick<Download, 'cancel' | 'saveAs'>;

    try {
      const artifact = await saveAndValidateFidelityBrowserDownload(download, directory, {
        artifactType: 'activity-csv',
        fileName,
        account: retailAccount,
        coveredFrom: '2026-07-01',
        coveredThrough: '2026-07-31',
      });

      expect(artifact.parserId).toBe('fidelity-activity-csv');
      expect(artifact.transactionCount).toBe(1);
      expect(await readFile(artifact.path, 'utf8')).toBe(csv);
      expect(cancelCalls).toBe(1);
      expect((await readdir(directory)).filter(name => name.endsWith('.partial'))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('removes a browser-generated download that fails parser validation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'easymoney-fidelity-invalid-download-test-'));
    const fileName = fidelityArtifactFileName(retailAccount, 'activity-csv', '2026-07-01', '2026-07-31');
    let cancelCalls = 0;
    const download = {
      saveAs: async (path: string) => writeFile(path, '<html>Sign in</html>'),
      cancel: async () => {
        cancelCalls += 1;
      },
    } as unknown as Pick<Download, 'cancel' | 'saveAs'>;

    try {
      await expect(saveAndValidateFidelityBrowserDownload(download, directory, {
        artifactType: 'activity-csv',
        fileName,
        account: retailAccount,
        coveredFrom: '2026-07-01',
        coveredThrough: '2026-07-31',
      })).rejects.toBeDefined();
      expect(cancelCalls).toBe(1);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('recognizes Fidelity maintenance separately from authentication failures', () => {
  expect(isFidelityInstitutionUnavailableText(
    "Sorry, we can't complete this action right now. Please try again.",
  )).toBe(true);
  expect(isFidelityInstitutionUnavailableText('Scheduled maintenance is in progress.')).toBe(true);
  expect(isFidelityInstitutionUnavailableText('Enter your username and password.')).toBe(false);
});

test('Fidelity authentication waits classify login before maintenance copy', async () => {
  const source = await readFile(new URL('./fidelity.ts', import.meta.url), 'utf8');
  const waitStart = source.indexOf('export async function waitUntilFidelityAuthenticated');
  const waitEnd = source.indexOf('\ntype PageGate', waitStart);
  const waitSource = source.slice(waitStart, waitEnd);
  expect(waitSource.indexOf('authenticationPath || hasAuthenticationField')).toBeGreaterThan(-1);
  expect(waitSource.indexOf('authenticationPath || hasAuthenticationField')).toBeLessThan(
    waitSource.indexOf("return 'institution-unavailable'"),
  );

  const navigationStart = source.indexOf('async function navigateToFidelityPage');
  const navigationEnd = source.indexOf('\nfunction assertGate', navigationStart);
  const navigationSource = source.slice(navigationStart, navigationEnd);
  expect(navigationSource.indexOf('fidelityAuthenticationRoute(currentUrl)')).toBeLessThan(
    navigationSource.indexOf("return 'institution-unavailable'"),
  );
});

test('Fidelity institution code uses direct requests and no fixed browser sleeps', async () => {
  const source = await readFile(new URL('./fidelity.ts', import.meta.url), 'utf8');
  expect(source).toContain('page.evaluate(fidelityBrowserFetchInPage');
  expect(source).toContain("credentials: 'include'");
  expect(source).toContain("redirect: 'manual'");
  expect(source).not.toContain('page.context().request');
  expect(source).toContain('#account-selector:visible section[aria-label] a');
  expect(source).not.toContain('normalizeHeadlessUserAgent');
  expect(source).not.toContain('HeadlessChrome/');
  expect(source).not.toContain('newCDPSession');
  expect(source).not.toMatch(/waitForTimeout|Bun\.sleep|setTimeout\s*\(/);
  expect(source).not.toContain('allowInteractiveAuthentication');
});
