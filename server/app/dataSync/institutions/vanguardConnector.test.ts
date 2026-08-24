import { expect, test } from 'bun:test';

import type {
  SyncAccountCoverage,
  SyncConnectorContext,
  SyncConnectorRunContext,
} from '../connector.ts';
import type { SyncEvent } from '../protocol.ts';
import {
  createVanguardConnector,
  inferVanguardAccountKind,
  inferVanguardAccountLast4,
  matchesVanguardAccount,
  missingVanguardMonthlyStatementDates,
  planVanguardProfiles,
  routeVanguardArtifacts,
  selectVanguardProfiles,
  vanguardConnector,
  vanguardProfileIdFromArtifactFileNames,
} from './vanguardConnector.ts';
import type {
  VanguardDownloadedArtifact,
  VanguardProgressReporter,
  VanguardSyncConfig,
} from './vanguard.ts';

function account(
  overrides: Partial<SyncAccountCoverage> & Pick<SyncAccountCoverage, 'id' | 'name'>,
): SyncAccountCoverage {
  return {
    institution: 'Vanguard',
    type: 'investment',
    latestFactDate: '2026-07-31',
    earliestFactDate: '2025-01-01',
    latestBalanceDate: '2026-07-31',
    earliestBalanceDate: '2025-01-31',
    balanceDates: ['2026-05-31', '2026-07-31'],
    sourceAccountName: null,
    sourceAccountNames: [],
    accountAliases: [],
    accountHolder: 'Example One',
    artifactFileNames: [],
    ...overrides,
  };
}

function context(accounts: SyncAccountCoverage[]): SyncConnectorContext {
  return { today: '2026-08-16', accounts };
}

function runContext(
  accounts: SyncAccountCoverage[],
  report: SyncConnectorRunContext['report'] = () => {},
  connectionId?: string,
): SyncConnectorRunContext {
  return {
    ...context(accounts),
    ...(connectionId ? { connectionId } : {}),
    goal: { kind: 'current', overlapDays: 7 },
    outputDir: '/tmp/vanguard-connector-test',
    report,
  };
}

const twoProfileAccounts = [
  account({
    id: 10,
    name: 'Brokerage 1111',
    sourceAccountName: 'Individual brokerage account ending in 1111',
    artifactFileNames: ['vanguard-current-brokerage-2026-07-24-to-2026-08-16-activity-1111.csv'],
  }),
  account({
    id: 20,
    name: 'Roth IRA 2222',
    sourceAccountName: 'Roth IRA account ending in 2222',
    accountHolder: 'Example Two',
    artifactFileNames: ['2026-07-31-Roth-IRA-2222---account-2.pdf'],
  }),
];

test('Vanguard connector plans independent login profiles from artifact provenance', () => {
  const profiles = planVanguardProfiles(
    context(twoProfileAccounts),
    { kind: 'current', overlapDays: 7 },
  );

  expect(profiles).toEqual([
    {
      id: 'current',
      session: 'vanguard-catchup',
      accountHolder: 'Example One',
      accounts: [{
        accountId: 10,
        accountKind: 'brokerage',
        accountLast4: '1111',
        startDate: '2026-07-24',
        statementDates: [],
      }],
    },
    {
      id: 'account-2',
      session: 'vanguard-account-2-catchup',
      accountHolder: 'Example Two',
      accounts: [{
        accountId: 20,
        accountKind: 'roth-ira',
        accountLast4: '2222',
        startDate: '2026-07-24',
        statementDates: [],
      }],
    },
  ]);
});

test('Vanguard connector safely assigns accounts without provenance by unique account holder', () => {
  const profiles = planVanguardProfiles(
    context([
      ...twoProfileAccounts,
      account({
        id: 30,
        name: 'Rollover IRA 3333',
        sourceAccountName: 'Rollover IRA account ending in 3333',
        accountHolder: 'Example One',
      }),
    ]),
    { kind: 'current', overlapDays: 7 },
  );

  expect(profiles[0]?.accounts).toContainEqual({
    accountId: 30,
    accountKind: 'traditional-ira',
    accountLast4: '3333',
    startDate: '2026-07-24',
    statementDates: [],
  });
});

test('Vanguard connector does not infer a profile when one holder has multiple logins', () => {
  const warnings: string[] = [];
  const profiles = planVanguardProfiles(
    context([
      twoProfileAccounts[0]!,
      { ...twoProfileAccounts[1]!, accountHolder: 'Example One' },
      account({
        id: 30,
        name: 'Rollover IRA 3333',
        sourceAccountName: 'Rollover IRA account ending in 3333',
        accountHolder: 'Example One',
      }),
    ]),
    { kind: 'current', overlapDays: 7 },
    event => warnings.push(event.message),
  );

  expect(profiles.flatMap(profile => profile.accounts).map(plan => plan.accountId)).toEqual([10, 20]);
  expect(warnings).toContain(
    'Skipped Rollover IRA 3333; its Vanguard login profile, account number, or account holder is missing',
  );
});

test('Vanguard statement planning includes only missing completed month ends', () => {
  expect(missingVanguardMonthlyStatementDates(
    '2026-05-25',
    '2026-08-16',
    ['2026-05-31', '2026-07-31'],
  )).toEqual(['2026-06-30']);
  expect(missingVanguardMonthlyStatementDates(
    '2026-08-01',
    '2026-08-16',
    [],
  )).toEqual([]);
});

test('Vanguard connection selection isolates one login without changing all-profile runs', () => {
  const profiles = planVanguardProfiles(
    context(twoProfileAccounts),
    { kind: 'current', overlapDays: 7 },
  );

  expect(selectVanguardProfiles(profiles, 'account-2')).toEqual([profiles[1]]);
  expect(selectVanguardProfiles(profiles)).toEqual(profiles);
  expect(selectVanguardProfiles(profiles, 'missing')).toEqual([]);
});

test('Vanguard connector rejects unsafe provenance and incomplete or conflicting holder data', () => {
  const warnings: string[] = [];
  const profiles = planVanguardProfiles(
    context([
      account({
        id: 1,
        name: 'Brokerage 1111',
        artifactFileNames: ['2026-07-31-Brokerage-1111---person-derived-label.pdf'],
      }),
      account({
        id: 2,
        name: 'Brokerage 2222',
        accountHolder: '   ',
        artifactFileNames: ['2026-07-31-Brokerage-2222---login-2.pdf'],
      }),
      account({
        id: 3,
        name: 'Brokerage 3333',
        artifactFileNames: ['2026-07-31-Brokerage-3333---account-3.pdf'],
      }),
      account({
        id: 4,
        name: 'Roth IRA 4444',
        accountHolder: 'Example Two',
        artifactFileNames: ['2026-07-31-Roth-IRA-4444---account-3.pdf'],
      }),
    ]),
    { kind: 'current', overlapDays: 7 },
    event => warnings.push(event.message),
  );

  expect(profiles).toEqual([]);
  expect(warnings).toEqual([
    'Skipped Vanguard profile account-3; its accounts have conflicting account holders',
    'Skipped Brokerage 1111; its Vanguard login profile, account number, or account holder is missing',
    'Skipped Brokerage 2222; its Vanguard login profile, account number, or account holder is missing',
  ]);
});

test('Vanguard targets identify every valid login by account holder', () => {
  expect(vanguardConnector.listTargets(context(twoProfileAccounts))).toEqual([
    { connectionId: 'current', label: 'Vanguard (Example One)' },
    { connectionId: 'account-2', label: 'Vanguard (Example Two)' },
  ]);
});

test('Vanguard identity helpers do not depend on generic shared routing', () => {
  const brokerage = account({
    id: 1,
    name: 'Investment account',
    sourceAccountName: 'Individual brokerage account XXXX1111',
  });
  const ambiguous = account({
    id: 2,
    name: 'Roth IRA 2222',
    accountAliases: ['Roth IRA 3333'],
  });

  expect(matchesVanguardAccount(brokerage)).toBe(true);
  expect(matchesVanguardAccount({ ...brokerage, institution: 'Example Bank' })).toBe(false);
  expect(inferVanguardAccountKind(brokerage)).toBe('brokerage');
  expect(inferVanguardAccountKind(account({ id: 3, name: 'Rollover IRA 4444' }))).toBe(
    'traditional-ira',
  );
  expect(inferVanguardAccountLast4(brokerage)).toBe('1111');
  expect(inferVanguardAccountLast4(ambiguous)).toBeNull();
  expect(vanguardProfileIdFromArtifactFileNames([
    'vanguard-login-2-traditional-ira-2026-01-01-to-2026-08-16-activity-4444.csv',
  ])).toBe('login-2');
  expect(vanguardProfileIdFromArtifactFileNames([
    '2026-07-31-Trad-IRA-4444---person-derived-label.pdf',
  ])).toBeNull();
});

test('Vanguard downloaded artifacts expose only generic routing data', () => {
  const artifact: VanguardDownloadedArtifact = {
    fileName: 'activity.csv',
    accountId: 42,
    institution: 'vanguard',
    profileId: 'current',
    accountKind: 'brokerage',
    accountLast4: '1111',
    artifactType: 'activity',
  };

  expect(routeVanguardArtifacts([artifact])).toEqual([{ fileName: 'activity.csv', accountId: 42 }]);
});

test('Vanguard connector selects one profile, translates progress, and routes artifacts', async () => {
  const configs: VanguardSyncConfig[] = [];
  const events: Array<Omit<SyncEvent, 'runId' | 'timestamp'>> = [];
  const connector = createVanguardConnector(async (
    config: VanguardSyncConfig,
    progress: VanguardProgressReporter = () => {},
  ) => {
    configs.push(config);
    progress({
      profileId: 'current',
      phase: 'authentication',
      state: 'waiting',
      timestamp: '2026-08-24T00:00:00.000Z',
      message: 'Waiting for Vanguard authentication for Example One',
      elapsedMs: 125,
      data: { cachedAuthentication: false },
    });
    return [{
      fileName: 'activity.csv',
      accountId: 10,
      institution: 'vanguard',
      profileId: 'current',
      accountKind: 'brokerage',
      accountLast4: '1111',
      artifactType: 'activity',
    }];
  });

  await expect(connector.run(runContext(
    twoProfileAccounts,
    event => events.push(event),
    'current',
  ))).resolves.toEqual([{ fileName: 'activity.csv', accountId: 10 }]);

  expect(configs).toHaveLength(1);
  expect(configs[0]?.profiles.map(profile => profile.id)).toEqual(['current']);
  expect(events).toContainEqual({
    type: 'action',
    message: 'Waiting for Vanguard authentication for Example One',
    data: {
      phase: 'authentication',
      state: 'waiting',
      profileId: 'current',
      elapsedMs: 125,
      cachedAuthentication: false,
    },
  });
});
