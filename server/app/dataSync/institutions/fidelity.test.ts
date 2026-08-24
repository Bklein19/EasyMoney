import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fidelityAccountsFromCandidates,
  fidelityArtifactFileName,
  fidelityDirectRequestUrl,
  fidelityStatementPlans,
  isFidelityInstitutionUnavailableText,
  validateFidelityArtifact,
  type FidelityAccountIdentity,
} from './fidelity.ts';

const retailAccount: FidelityAccountIdentity = {
  surface: 'retail',
  kind: 'brokerage',
  accountKey: 'retail-account',
  last4: '1234',
};

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

  test('rejects ambiguous routing suffixes on the same Fidelity surface', () => {
    expect(() => fidelityAccountsFromCandidates([
      { surface: 'retail', label: 'Brokerage 1234', remoteId: 'one' },
      { surface: 'retail', label: 'Roth IRA 1234', remoteId: 'two' },
    ])).toThrow('Multiple Fidelity retail accounts share one routing suffix');
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

describe('Fidelity statement planning', () => {
  test('routes statements by account suffix and filters the requested date range', () => {
    const accounts = fidelityAccountsFromCandidates([
      { surface: 'retail', label: 'Brokerage 1234', remoteId: 'one' },
      { surface: 'retail', label: 'Roth IRA 5678', remoteId: 'two' },
    ]);
    const plans = fidelityStatementPlans([
      {
        surface: 'retail',
        label: 'Brokerage 1234 statement July 31, 2026',
        href: 'https://digital.fidelity.com/documents/one.pdf',
      },
      {
        surface: 'retail',
        label: 'Roth IRA 5678 statement 06/30/2026',
        href: 'https://digital.fidelity.com/documents/two.pdf',
      },
      {
        surface: 'retail',
        label: 'Brokerage 1234 statement March 31, 2026',
        href: 'https://digital.fidelity.com/documents/old.pdf',
      },
    ], accounts, '2026-04-01', '2026-08-24');

    expect(plans).toHaveLength(2);
    expect(plans.map(plan => [plan.account.last4, plan.coveredThrough])).toEqual([
      ['1234', '2026-07-31'],
      ['5678', '2026-06-30'],
    ]);
  });

  test('rejects a statement that cannot be assigned to exactly one account', () => {
    const accounts = fidelityAccountsFromCandidates([
      { surface: 'retail', label: 'Brokerage 1234', remoteId: 'one' },
      { surface: 'retail', label: 'Roth IRA 5678', remoteId: 'two' },
    ]);
    expect(() => fidelityStatementPlans([{
      surface: 'retail',
      label: 'Monthly statement July 31, 2026',
      href: 'https://digital.fidelity.com/documents/unknown.pdf',
    }], accounts, '2026-04-01', '2026-08-24')).toThrow(
      'Fidelity document account identity is ambiguous',
    );
  });
});

describe('Fidelity artifact validation', () => {
  test('validates a downloaded activity CSV with the Fidelity parser', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'easymoney-fidelity-test-'));
    await mkdir(directory, { recursive: true });
    const fileName = fidelityArtifactFileName(retailAccount, 'activity-csv', '2026-07-01', '2026-07-31');
    const path = join(directory, fileName);
    await writeFile(path, [
      'Run Date,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date',
      '07/15/2026,DIVIDEND RECEIVED,EXAMPLE,EXAMPLE FUND,Cash,0,0,0,0,0,12.34,1000.00,07/15/2026',
    ].join('\n'));

    try {
      const validation = await validateFidelityArtifact(path, {
        artifactType: 'activity-csv',
        fileName,
        account: retailAccount,
      });
      expect(validation.parserId).toBe('fidelity-activity-csv');
      expect(validation.transactionCount).toBe(1);
      expect(validation.parsedAccountLast4s).toEqual([]);
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
