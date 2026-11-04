import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Page } from 'playwright';

import { robinhoodCreditApiParser } from '../../importParsers/robinhoodCreditApi.ts';
import { runInstitutionBrowserProgram } from '../browserSession.ts';
import type { RoutedSyncArtifact, SyncConnectorRunContext } from '../connector.ts';
import { goalWindowForCoverage } from '../planning.ts';
import {
  createRobinhoodCreditQuery,
  discoverRobinhoodCreditAccounts,
  fetchRobinhoodCreditTransactionPages,
  RobinhoodAuthenticationRequired,
  ROBINHOOD_CREDIT_ACCOUNT_QUERY,
  ROBINHOOD_CREDIT_IDENTITY_QUERY,
  ROBINHOOD_CREDIT_STATEMENTS_QUERY,
  robinhoodRecord,
} from './robinhoodCreditHttp.ts';

export const ROBINHOOD_CREDIT_PROFILE_NAME = 'robinhood-credit-catchup';
const LOGIN_URL = 'https://robinhood.com/login/?to=%2Fbanking';

/** Read only the already-authorized browser token; credentials never leave the login page. */
async function robinhoodSessionToken(page: Page): Promise<string | undefined> {
  if (new URL(page.url()).origin !== 'https://robinhood.com') return undefined;
  return page.evaluate(() => {
    const raw = localStorage.getItem('web:auth_state');
    function find(value: unknown, depth = 0): string | undefined {
      if (!value || typeof value !== 'object' || depth > 4) return;
      const object = value as Record<string, unknown>;
      if (typeof object.access_token === 'string') return object.access_token;
      if (typeof object.accessToken === 'string') return object.accessToken;
      for (const [key, item] of Object.entries(object)) {
        if (/password|credential/i.test(key)) continue;
        const token = find(item, depth + 1);
        if (token) return token;
      }
    }
    try {
      return raw ? find(JSON.parse(raw)) : undefined;
    } catch {
      return undefined;
    }
  });
}

export async function isRobinhoodCreditAuthenticated(page: Page): Promise<boolean> {
  const url = new URL(page.url());
  if (url.origin !== 'https://robinhood.com' || url.pathname.startsWith('/login')) return false;
  if (await page.locator('input[type="password"]:visible').count()) return false;
  return Boolean(await robinhoodSessionToken(page));
}

export function robinhoodCreditCoverageWindow(context: SyncConnectorRunContext): {
  from: string;
  to: string;
} {
  if (context.accounts.length === 0) {
    return {
      from:
        context.goal.kind === 'range'
          ? context.goal.startDate
          : context.goal.kind === 'backfill'
            ? (context.goal.stopAt ?? '2000-01-01')
            : '2000-01-01',
      to: context.goal.kind === 'range' ? context.goal.endDate : context.today,
    };
  }
  const windows = context.accounts.map((account) =>
    goalWindowForCoverage(context.goal, account, context.today),
  );
  return {
    from: windows.map((window) => window.startDate).sort()[0]!,
    to: windows
      .map((window) => window.endDate)
      .sort()
      .at(-1)!,
  };
}

async function downloadRobinhoodCreditArtifacts(
  page: Page,
  context: SyncConnectorRunContext,
): Promise<RoutedSyncArtifact[]> {
  const token = await robinhoodSessionToken(page);
  if (!token) throw new RobinhoodAuthenticationRequired();
  const query = createRobinhoodCreditQuery(page, token);
  context.report({
    type: 'phase',
    message: 'Discovering Robinhood credit card accounts',
    data: { step: 'account-discovery', status: 'started' },
  });
  const identityResponse = await query(
    'CriticalDataProviderQuery',
    ROBINHOOD_CREDIT_IDENTITY_QUERY,
  );
  const { identityId, accounts } = discoverRobinhoodCreditAccounts(identityResponse.data);
  // Current live protocol evidence covers one card account per authenticated
  // identity. Avoid attributing an identity-wide page to a second account until
  // account filtering has been validated with a real multi-account session.
  if (accounts.length !== 1) {
    throw new Error('Robinhood credit sync requires an unambiguous single card account');
  }
  const accountResponse = await query('CreditCardScreenQuery', ROBINHOOD_CREDIT_ACCOUNT_QUERY);
  const catalogResponse = await query('StatementsScreenQuery', ROBINHOOD_CREDIT_STATEMENTS_QUERY);
  const { from, to } = robinhoodCreditCoverageWindow(context);
  const timeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const capturedAt =
    accountResponse.capturedAt ?? identityResponse.capturedAt ?? new Date().toISOString();
  const artifacts: RoutedSyncArtifact[] = [];
  await mkdir(context.outputDir, { recursive: true, mode: 0o700 });
  for (const account of accounts) {
    let fetchedCount = 0;
    const transactionResponses = await fetchRobinhoodCreditTransactionPages(query, {
      identityId,
      customerId: account.customerId,
      from,
      timeZone,
      onPage(count) {
        fetchedCount += count;
        context.report({
          type: 'phase',
          message: 'Reading Robinhood credit card activity',
          data: { step: 'activity-download', transactionCount: fetchedCount },
        });
      },
    });
    const envelope = {
      format: 'easymoney-robinhood-credit-v1',
      capturedAt,
      account,
      request: { from, to, timeZone },
      identityResponse: identityResponse.body,
      accountResponse: accountResponse.body,
      statementCatalogResponse: catalogResponse.body,
      transactionResponses,
    };
    const suffix = createHash('sha256').update(account.id).digest('hex').slice(0, 12);
    const fileName = `robinhood-credit-${suffix}-activity-${from}-to-${to}.json`;
    const text = JSON.stringify(envelope);
    const parsed = await robinhoodCreditApiParser.parse({ fileName, text, headers: [], rows: [] });
    const transactionCount = parsed.transactions.filter(Boolean).length;
    await writeFile(join(context.outputDir, fileName), text, { mode: 0o600 });
    context.report({
      type: 'artifact',
      message: 'Robinhood credit card activity and balance are ready for review',
      data: {
        step: 'validation',
        artifactKind: 'activity-json',
        parserValidated: true,
        transactionCount,
        balanceCount: parsed.balances.length,
      },
    });
    artifacts.push({ fileName, routing: 'source' });
    const catalogIdentity = robinhoodRecord(catalogResponse.data.authIdentity);
    const customers = catalogIdentity?.creditCustomers;
    const customer = Array.isArray(customers)
      ? customers.map(robinhoodRecord).find((value) => value?.id === account.customerId)
      : null;
    const statements = robinhoodRecord(customer?.account)?.statements;
    if (Array.isArray(statements) && statements.length > 0) {
      context.report({
        type: 'warning',
        message:
          'Robinhood has historical statements; this connection currently imports activity and the current balance',
        data: { step: 'statement-discovery', unavailableArtifactCount: statements.length },
      });
    }
  }
  return artifacts;
}

export async function runRobinhoodCreditSync(
  context: SyncConnectorRunContext,
): Promise<RoutedSyncArtifact[]> {
  const result = await runInstitutionBrowserProgram<{ artifacts: RoutedSyncArtifact[] }>(
    { name: ROBINHOOD_CREDIT_PROFILE_NAME, startUrl: LOGIN_URL },
    `async (page, _report, bindings) => bindings.execute(page)`,
    {
      completionDescription: 'Robinhood credit card downloads are ready for review.',
      authenticationRecoveryUrl: LOGIN_URL,
      isAuthenticated: isRobinhoodCreditAuthenticated,
      onProgress(message) {
        context.report({ type: 'phase', message });
      },
      programBindings: {
        async execute(page: Page) {
          if (!(await isRobinhoodCreditAuthenticated(page))) return { status: 'login-required' };
          try {
            const artifacts = await downloadRobinhoodCreditArtifacts(page, context);
            return { status: 'complete', artifacts };
          } catch (error) {
            if (error instanceof RobinhoodAuthenticationRequired)
              return { status: 'login-required' };
            const diagnostic =
              error instanceof Error &&
              /^Robinhood (?:credit|transaction) [a-zA-Z ]+[a-zA-Z.]$/.test(error.message)
                ? error.message
                : 'Robinhood credit sync stopped before artifact validation';
            context.report({
              type: 'warning',
              message: 'Robinhood credit card download stopped',
              data: { diagnostic },
            });
            throw error;
          }
        },
      },
    },
  );
  if (result.status === 'login-required') throw new RobinhoodAuthenticationRequired();
  if (result.status !== 'complete') throw new Error('Robinhood credit card sync did not complete');
  return result.artifacts;
}
