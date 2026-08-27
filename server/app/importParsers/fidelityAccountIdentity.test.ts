import { describe, expect, test } from 'bun:test';

import {
  fidelityAccountNumber,
  fidelityRemoteAccountId,
  withFidelityRemoteAccountIds,
} from './fidelityAccountIdentity.ts';

describe('Fidelity parser account identity', () => {
  test('normalizes full Fidelity account numbers without accepting last-four labels', () => {
    expect(fidelityAccountNumber('Account Number: Z00-000000')).toBe('Z00000000');
    expect(fidelityAccountNumber('Health Savings Account 111-222333')).toBe('111222333');
    expect(fidelityRemoteAccountId('Z00-000000')).toBe('fidelity:Z00000000');
    expect(fidelityRemoteAccountId('Brokerage ending in 0000')).toBeNull();
    expect(fidelityRemoteAccountId('Accounts 111-222333 and 444-555666')).toBeNull();
  });

  test('adds the same exact remote identity to statement transactions and balances', () => {
    expect(withFidelityRemoteAccountIds({
      transactions: [{
        sourceRowIndex: 0,
        date: '2026-07-31',
        amountCents: 1234,
        description: 'Example activity',
        institution: 'Fidelity',
        account: 'Z00-000000',
        sourceRole: 'activity',
      }],
      balances: [{
        sourceRowIndex: 0,
        date: '2026-07-31',
        balanceCents: 123_456,
        institution: 'Fidelity',
        account: 'Investment Account Z00-000000',
      }],
    })).toMatchObject({
      transactions: [{ remoteAccountId: 'fidelity:Z00000000' }],
      balances: [{ remoteAccountId: 'fidelity:Z00000000' }],
    });
  });
});
