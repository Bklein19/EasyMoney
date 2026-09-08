import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wellsFargoActivityParser } from '../../importParsers/wellsFargoActivity.ts';
import { parseWellsFargoStatementText } from '../../importParsers/moneyParsers/wells-fargo-statement-pdf.ts';
import {
  buildWellsFargoBrowserProgram,
  createWellsFargoProgress,
  mapWellsFargoAccounts,
  parseWellsFargoAccountCandidates,
  openWellsFargoAccount,
  safeWellsFargoDiagnostic,
  selectWellsFargoStatements,
  validateWellsFargoArtifact,
  wellsFargoAccountLast4FromLabel,
  wellsFargoActivityRequestFromForm,
  wellsFargoArtifactPlanFromFilename,
  wellsFargoDateFromText,
  wellsFargoBrowserWindowProgress,
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
  expect(accounts.map(account => account.destination)).toEqual([
    'https://connect.secure.wellsfargo.com/accounts/deposit/one',
    'https://connect.secure.wellsfargo.com/accounts/deposit/two',
    'https://connect.secure.wellsfargo.com/accounts/deposit/three',
    'https://connect.secure.wellsfargo.com/accounts/card/four',
    'https://connect.secure.wellsfargo.com/accounts/card/five',
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

test('Wells Fargo reopens a discovered account directly without returning through account summary', async () => {
  const destination = 'https://connect.secure.wellsfargo.com/accounts/card/detail';
  let currentUrl = 'https://connect.secure.wellsfargo.com/accounts/deposit/detail';
  const gotoCalls: string[] = [];
  let clickCount = 0;
  const locator = (count: number, headings: string[] = []) => ({
    first() { return this; },
    waitFor: async () => {},
    count: async () => count,
    allTextContents: async () => headings,
    click: async () => { clickCount += 1; },
  });
  const page = {
    url: () => currentUrl,
    goto: async (url: string) => {
      gotoCalls.push(url);
      currentUrl = url;
    },
    locator: () => locator(0),
    getByRole: (role: string, options?: { name?: RegExp }) => {
      if (role === 'heading' && !options) return locator(1, ['Credit Card']);
      if (role === 'link' && options?.name?.source.includes('Sign Off')) return locator(1);
      return locator(0);
    },
  } as unknown as Parameters<typeof openWellsFargoAccount>[0];

  await openWellsFargoAccount(page, {
    kind: 'credit-card',
    last4: '3001',
    destination,
  });

  expect(gotoCalls).toEqual([destination]);
  expect(clickCount).toBe(0);
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
      destination: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/opening',
    },
    {
      date: '2026-06-30',
      destination: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/june',
    },
    {
      date: '2026-07-31',
      destination: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/july',
    },
    {
      date: '2026-08-31',
      destination: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/august',
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
      destination: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/first',
    },
    {
      date: '2026-07-31',
      destination: 'https://connect.secure.wellsfargo.com/edocs/documents/retrieve/second',
    },
  ], '2026-07-01', '2026-08-01')).toThrow('multiple statement documents');
});

test('Wells Fargo statement dates normalize observed numeric, named, and ISO forms', () => {
  expect(wellsFargoDateFromText('Statement 8/1/2026')).toBe('2026-08-01');
  expect(wellsFargoDateFromText('August 1, 2026 statement')).toBe('2026-08-01');
  expect(wellsFargoDateFromText('/retrieve/2026-08-01')).toBe('2026-08-01');
  expect(wellsFargoDateFromText('Statement available')).toBeNull();
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
