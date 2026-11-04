import { expect, test } from 'bun:test';

import type { SyncAccountCoverage, SyncConnectorRunContext } from '../connector.ts';
import { robinhoodCreditCoverageWindow } from './robinhoodCredit.ts';
import { createRobinhoodCreditConnector } from './robinhoodCreditConnector.ts';

function account(type: string, institution = 'Robinhood'): SyncAccountCoverage {
  return {
    id: 1,
    name: type,
    type,
    institution,
    latestFactDate: '2026-10-30',
    earliestFactDate: '2026-09-01',
    latestBalanceDate: null,
    earliestBalanceDate: null,
    balanceDates: [],
    sourceAccountName: null,
    sourceAccountNames: [],
    accountAliases: [],
    accountHolder: null,
    artifactFileNames: [],
  };
}

const context: SyncConnectorRunContext = {
  accounts: [],
  today: '2026-11-03',
  goal: { kind: 'current', overlapDays: 7 },
  outputDir: '/tmp/synthetic',
  report: () => {},
};

test('Robinhood card bootstrap target works before any local account exists', async () => {
  let input: SyncConnectorRunContext | undefined;
  const connector = createRobinhoodCreditConnector(async (value) => {
    input = value;
    return [];
  });
  expect(connector.listTargets(context)).toEqual([{ label: 'Robinhood Credit Card' }]);
  await connector.run({
    ...context,
    accounts: [account('credit'), account('checking'), account('credit', 'Other')],
  });
  expect(input?.accounts).toEqual([account('credit')]);
});

test('first card connection requests all available history and later runs overlap coverage', () => {
  expect(robinhoodCreditCoverageWindow(context)).toEqual({ from: '2000-01-01', to: '2026-11-03' });
  expect(robinhoodCreditCoverageWindow({ ...context, accounts: [account('credit')] })).toEqual({
    from: '2026-10-23',
    to: '2026-11-03',
  });
  expect(
    robinhoodCreditCoverageWindow({
      ...context,
      goal: {
        kind: 'range',
        startDate: '2026-10-01',
        endDate: '2026-10-31',
      },
    }),
  ).toEqual({ from: '2026-10-01', to: '2026-10-31' });
});
