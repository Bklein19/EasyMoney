import type { SyncAccountCoverage, SyncConnector } from '../connector.ts';
import { runRobinhoodCreditSync } from './robinhoodCredit.ts';
import { robinhoodAccountKind } from './robinhoodBankingConnector.ts';

export function matchesRobinhoodCreditAccount(account: SyncAccountCoverage): boolean {
  return robinhoodAccountKind(account) === 'credit';
}

export function createRobinhoodCreditConnector(
  run = runRobinhoodCreditSync,
): SyncConnector<'robinhood-credit'> {
  return {
    id: 'robinhood-credit',
    label: 'Robinhood Credit Card',
    matchesAccount: matchesRobinhoodCreditAccount,
    // Discovery supports the first connection before a local card account exists.
    listTargets: () => [{ label: 'Robinhood Credit Card' }],
    run(context) {
      return run({ ...context, accounts: context.accounts.filter(matchesRobinhoodCreditAccount) });
    },
  };
}

export const robinhoodCreditConnector = createRobinhoodCreditConnector();
