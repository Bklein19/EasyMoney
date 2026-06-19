import { beforeEach, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';

process.env.EASYMONEY_DB_PATH = path.join(os.tmpdir(), `easymoney-ledger-rebuild-${process.pid}.sqlite`);

const { getDb, initDatabase, insertRow } = await import('../database.js');
const { buildLedgerFromSourceFacts, ledgerFingerprint, materializeLedger } = await import('./ledgerRebuild.ts');
const { upsertTransactionAnnotation } = await import('./transactionAnnotations.ts');

function resetAppTables() {
  const db = getDb();
  initDatabase();
  db.transaction(() => {
    for (const table of [
      'sourceBalances',
      'sourceTransactions',
      'sourceAccounts',
      'sourceFiles',
      'importRows',
      'importFiles',
      'ledgerTransactions',
      'ledgerBalances',
      'transactionAnnotations',
      'transactions',
      'balanceSnapshots',
      'accountAliases',
      'budgets',
      'categorizationRules',
      'importProfiles',
      'categories',
      'accounts',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
    }
  })();
}

function insertCommittedSourceFile({
  fileName,
  parserName,
  sourceType,
  priority,
  institution,
}: {
  fileName: string;
  parserName: string;
  sourceType: string;
  priority: number;
  institution: string;
}) {
  const now = new Date().toISOString();
  const importFileId = Number(insertRow('importFiles', {
    fileName,
    contentHash: `${fileName}-hash`,
    parserName,
    sourceType,
    parserPriority: priority,
    institution,
    rowCount: 0,
    status: 'committed',
    committedAt: now,
    createdAt: now,
  }));
  const sourceFileId = Number(insertRow('sourceFiles', {
    importFileId,
    fileName,
    contentHash: `${fileName}-hash`,
    parserName,
    sourceType,
    parserPriority: priority,
    institution,
    status: 'committed',
    committedAt: now,
    createdAt: now,
  }));

  return { importFileId, sourceFileId };
}

function insertSourceAccount(
  sourceFileId: number,
  accountId: number,
  sourceAccountKey: string,
  {
    institution = 'Vanguard',
    sourceAccountName = 'Roth IRA brokerage account-XXXX0000',
  }: {
    institution?: string;
    sourceAccountName?: string;
  } = {}
) {
  return Number(insertRow('sourceAccounts', {
    sourceFileId,
    accountId,
    institution,
    sourceAccountKey,
    sourceAccountName,
    rawJson: JSON.stringify({ account: sourceAccountName }),
    createdAt: new Date().toISOString(),
  }));
}

function insertSourceTransaction({
  sourceFileId,
  sourceAccountId,
  stableSourceId,
  date,
  amountCents,
  description,
  sourceRole = 'activity',
  priority,
  raw = {},
}: {
  sourceFileId: number;
  sourceAccountId: number;
  stableSourceId: string;
  date: string;
  amountCents: number;
  description: string;
  sourceRole?: string;
  priority: number;
  raw?: Record<string, unknown>;
}) {
  return Number(insertRow('sourceTransactions', {
    sourceFileId,
    sourceAccountId,
    stableSourceId,
    date,
    amountCents,
    description,
    sourceRole,
    priority,
    rawJson: JSON.stringify(raw),
    createdAt: new Date().toISOString(),
  }));
}

function insertSourceBalance({
  sourceFileId,
  sourceAccountId,
  date,
  balanceCents,
  priority,
}: {
  sourceFileId: number;
  sourceAccountId: number;
  date: string;
  balanceCents: number;
  priority: number;
}) {
  return Number(insertRow('sourceBalances', {
    sourceFileId,
    sourceAccountId,
    date,
    balanceCents,
    priority,
    rawJson: JSON.stringify({ source: 'sanitized-vanguard-statement' }),
    createdAt: new Date().toISOString(),
  }));
}

beforeEach(() => {
  resetAppTables();
});

test('sanitized Vanguard source facts rebuild investment activity and statement balances', () => {
  const accountId = Number(insertRow('accounts', {
    name: 'A Roth IRA',
    institution: 'Vanguard',
    type: 'investment',
    currentBalance: 0,
  }));
  const categoryId = Number(insertRow('categories', {
    name: 'Investing',
    type: 'investment',
  }));

  const activity = insertCommittedSourceFile({
    fileName: 'sanitized-vanguard-activity.pdf',
    parserName: 'vanguard-activity-pdf',
    sourceType: 'activity-export',
    priority: 100,
    institution: 'Vanguard',
  });
  const statement = insertCommittedSourceFile({
    fileName: 'sanitized-vanguard-statement.pdf',
    parserName: 'vanguard-statement-pdf',
    sourceType: 'statement',
    priority: 50,
    institution: 'Vanguard',
  });
  const activityAccountId = insertSourceAccount(activity.sourceFileId, accountId, 'vanguard-roth-0000');
  const statementAccountId = insertSourceAccount(statement.sourceFileId, accountId, 'vanguard-roth-0000');

  insertSourceTransaction({
    sourceFileId: activity.sourceFileId,
    sourceAccountId: activityAccountId,
    stableSourceId: 'vg-activity-contribution',
    date: '2026-05-02',
    amountCents: 700000,
    description: 'Contribution',
    priority: 100,
    raw: { type: 'contribution' },
  });
  insertSourceTransaction({
    sourceFileId: activity.sourceFileId,
    sourceAccountId: activityAccountId,
    stableSourceId: 'vg-activity-dividend',
    date: '2026-05-15',
    amountCents: 1423,
    description: 'Dividend received',
    priority: 100,
    raw: { type: 'dividend' },
  });
  insertSourceTransaction({
    sourceFileId: activity.sourceFileId,
    sourceAccountId: activityAccountId,
    stableSourceId: 'vg-activity-buy',
    date: '2026-05-16',
    amountCents: -701423,
    description: 'Buy VTSAX',
    priority: 100,
    raw: { type: 'buy' },
  });
  insertSourceBalance({
    sourceFileId: statement.sourceFileId,
    sourceAccountId: statementAccountId,
    date: '2026-05-31',
    balanceCents: 3050321,
    priority: 50,
  });

  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions.map(transaction => transaction.description).sort()).toEqual([
    'Buy VTSAX',
    'Contribution',
    'Dividend received',
  ]);
  expect(ledger.balanceSnapshots).toEqual([
    {
      accountId,
      month: '2026-05',
      balance: 30503.21,
      capturedAt: '2026-05-31T00:00:00.000Z',
      sourceBalanceId: 1,
    },
  ]);

  const fingerprint = ledgerFingerprint(ledger);
  materializeLedger(getDb(), ledger);

  const contribution = getDb().prepare("SELECT id, ledgerTransactionId FROM transactions WHERE description = 'Contribution'").get() as {
    id: number;
    ledgerTransactionId: string;
  };
  upsertTransactionAnnotation(contribution.id, {
    categoryId,
    notes: 'sanitized vanguard contribution',
  });

  getDb().prepare('DELETE FROM ledgerTransactions').run();
  getDb().prepare('DELETE FROM ledgerBalances').run();
  getDb().prepare('DELETE FROM transactions').run();
  getDb().prepare('DELETE FROM balanceSnapshots').run();

  const rebuilt = buildLedgerFromSourceFacts(getDb());
  expect(ledgerFingerprint(rebuilt)).toBe(fingerprint);
  materializeLedger(getDb(), rebuilt);

  const annotationJoin = getDb().prepare(`
    SELECT t.description, ta.categoryId, ta.notes
    FROM transactions t
    JOIN transactionAnnotations ta ON ta.ledgerTransactionId = t.ledgerTransactionId
    WHERE t.description = 'Contribution'
  `).get() as {
    description: string;
    categoryId: number;
    notes: string;
  };
  expect(annotationJoin).toEqual({
    description: 'Contribution',
    categoryId,
    notes: 'sanitized vanguard contribution',
  });
  expect(
    (getDb().prepare('SELECT COUNT(*) AS count FROM balanceSnapshots').get() as { count: number }).count
  ).toBe(1);
  expect(
    (getDb().prepare('SELECT COUNT(*) AS count FROM ledgerTransactions').get() as { count: number }).count
  ).toBe(3);
  expect(
    (getDb().prepare('SELECT COUNT(*) AS count FROM ledgerBalances').get() as { count: number }).count
  ).toBe(1);
});

test('source rebuild prefers statement balances over activity running balances in the same month', () => {
  const accountId = Number(insertRow('accounts', {
    name: 'BofA Checking',
    institution: 'Bank of America',
    type: 'checking',
    currentBalance: 0,
  }));

  const activity = insertCommittedSourceFile({
    fileName: 'bofa-activity.csv',
    parserName: 'bofa-activity-csv',
    sourceType: 'activity-export',
    priority: 100,
    institution: 'Bank of America',
  });
  const statement = insertCommittedSourceFile({
    fileName: 'bofa-statement.pdf',
    parserName: 'bofa-statement-pdf',
    sourceType: 'statement',
    priority: 50,
    institution: 'Bank of America',
  });

  const activityAccountId = insertSourceAccount(activity.sourceFileId, accountId, 'bofa-checking-5013', {
    institution: 'Bank of America',
    sourceAccountName: 'Adv Plus Banking - 5013',
  });
  const statementAccountId = insertSourceAccount(statement.sourceFileId, accountId, 'bofa-checking-5013', {
    institution: 'Bank of America',
    sourceAccountName: 'Adv Plus Banking - 5013',
  });

  insertSourceBalance({
    sourceFileId: statement.sourceFileId,
    sourceAccountId: statementAccountId,
    date: '2026-06-04',
    balanceCents: 620821,
    priority: 50,
  });
  insertSourceBalance({
    sourceFileId: activity.sourceFileId,
    sourceAccountId: activityAccountId,
    date: '2026-06-08',
    balanceCents: 371821,
    priority: 100,
  });

  const ledger = buildLedgerFromSourceFacts(getDb());

  expect(ledger.balanceSnapshots).toEqual([
    {
      accountId,
      month: '2026-06',
      balance: 6208.21,
      capturedAt: '2026-06-04T00:00:00.000Z',
      sourceBalanceId: 1,
    },
  ]);
});

test('source rebuild de-duplicates overlapping activity exports by source-file multiplicity', () => {
  const accountId = Number(insertRow('accounts', {
    name: 'WF Checking',
    institution: 'Wells Fargo',
    type: 'checking',
    currentBalance: 0,
  }));
  const exportA = insertCommittedSourceFile({
    fileName: 'checking-a.csv',
    parserName: 'wells-fargo-generic-activity-csv',
    sourceType: 'activity-export',
    priority: 90,
    institution: 'Wells Fargo',
  });
  const exportB = insertCommittedSourceFile({
    fileName: 'checking-b.csv',
    parserName: 'wells-fargo-generic-activity-csv',
    sourceType: 'activity-export',
    priority: 90,
    institution: 'Wells Fargo',
  });
  const accountA = insertSourceAccount(exportA.sourceFileId, accountId, 'checking-a', {
    institution: 'Wells Fargo',
    sourceAccountName: 'Checking',
  });
  const accountB = insertSourceAccount(exportB.sourceFileId, accountId, 'checking-b', {
    institution: 'Wells Fargo',
    sourceAccountName: 'Checking',
  });

  insertSourceTransaction({
    sourceFileId: exportA.sourceFileId,
    sourceAccountId: accountA,
    stableSourceId: 'a-starbucks',
    date: '2026-06-18',
    amountCents: -545,
    description: 'STARBUCKS STORE 123',
    priority: 90,
  });
  insertSourceTransaction({
    sourceFileId: exportB.sourceFileId,
    sourceAccountId: accountB,
    stableSourceId: 'b-starbucks',
    date: '2026-06-18',
    amountCents: -545,
    description: 'STARBUCKS STORE 123',
    priority: 90,
  });

  const ledger = buildLedgerFromSourceFacts(getDb());

  expect(ledger.transactions.map(transaction => transaction.description)).toEqual([
    'STARBUCKS STORE 123',
  ]);
});

test('source rebuild preserves same-day identical transactions seen multiple times in one activity export', () => {
  const accountId = Number(insertRow('accounts', {
    name: 'WF Checking',
    institution: 'Wells Fargo',
    type: 'checking',
    currentBalance: 0,
  }));
  const exportA = insertCommittedSourceFile({
    fileName: 'checking-a.csv',
    parserName: 'wells-fargo-generic-activity-csv',
    sourceType: 'activity-export',
    priority: 90,
    institution: 'Wells Fargo',
  });
  const exportB = insertCommittedSourceFile({
    fileName: 'checking-b.csv',
    parserName: 'wells-fargo-generic-activity-csv',
    sourceType: 'activity-export',
    priority: 90,
    institution: 'Wells Fargo',
  });
  const accountA = insertSourceAccount(exportA.sourceFileId, accountId, 'checking-a', {
    institution: 'Wells Fargo',
    sourceAccountName: 'Checking',
  });
  const accountB = insertSourceAccount(exportB.sourceFileId, accountId, 'checking-b', {
    institution: 'Wells Fargo',
    sourceAccountName: 'Checking',
  });

  for (const suffix of ['first', 'second']) {
    insertSourceTransaction({
      sourceFileId: exportA.sourceFileId,
      sourceAccountId: accountA,
      stableSourceId: `a-starbucks-${suffix}`,
      date: '2026-06-18',
      amountCents: -545,
      description: 'STARBUCKS STORE 123',
      priority: 90,
    });
    insertSourceTransaction({
      sourceFileId: exportB.sourceFileId,
      sourceAccountId: accountB,
      stableSourceId: `b-starbucks-${suffix}`,
      date: '2026-06-18',
      amountCents: -545,
      description: 'STARBUCKS STORE 123',
      priority: 90,
    });
  }

  const ledger = buildLedgerFromSourceFacts(getDb());

  expect(ledger.transactions.map(transaction => transaction.description)).toEqual([
    'STARBUCKS STORE 123',
    'STARBUCKS STORE 123',
  ]);
  expect(ledger.transactions.map(transaction => transaction.occurrenceIndex).sort()).toEqual([0, 1]);
});

test('source rebuild keeps the larger multiplicity from uneven overlapping activity exports', () => {
  const accountId = Number(insertRow('accounts', {
    name: 'WF Checking',
    institution: 'Wells Fargo',
    type: 'checking',
    currentBalance: 0,
  }));
  const exportA = insertCommittedSourceFile({
    fileName: 'checking-a.csv',
    parserName: 'wells-fargo-generic-activity-csv',
    sourceType: 'activity-export',
    priority: 90,
    institution: 'Wells Fargo',
  });
  const exportB = insertCommittedSourceFile({
    fileName: 'checking-b.csv',
    parserName: 'wells-fargo-generic-activity-csv',
    sourceType: 'activity-export',
    priority: 90,
    institution: 'Wells Fargo',
  });
  const accountA = insertSourceAccount(exportA.sourceFileId, accountId, 'checking-a', {
    institution: 'Wells Fargo',
    sourceAccountName: 'Checking',
  });
  const accountB = insertSourceAccount(exportB.sourceFileId, accountId, 'checking-b', {
    institution: 'Wells Fargo',
    sourceAccountName: 'Checking',
  });

  for (const suffix of ['first', 'second']) {
    insertSourceTransaction({
      sourceFileId: exportA.sourceFileId,
      sourceAccountId: accountA,
      stableSourceId: `a-coffee-${suffix}`,
      date: '2026-06-18',
      amountCents: -545,
      description: 'STARBUCKS STORE 123',
      priority: 90,
    });
  }
  insertSourceTransaction({
    sourceFileId: exportB.sourceFileId,
    sourceAccountId: accountB,
    stableSourceId: 'b-coffee',
    date: '2026-06-18',
    amountCents: -545,
    description: 'STARBUCKS STORE 123',
    priority: 90,
  });

  const ledger = buildLedgerFromSourceFacts(getDb());

  expect(ledger.transactions.map(transaction => transaction.description)).toEqual([
    'STARBUCKS STORE 123',
    'STARBUCKS STORE 123',
  ]);
});

test('source rebuild applies priority dedup while keeping statement-only transfers', () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Vanguard',
    institution: 'Vanguard',
    type: 'investment',
    currentBalance: 0,
  }));
  const activity = insertCommittedSourceFile({
    fileName: 'vanguard-activity.pdf',
    parserName: 'vanguard-activity-pdf',
    sourceType: 'activity-export',
    priority: 100,
    institution: 'Vanguard',
  });
  const statement = insertCommittedSourceFile({
    fileName: 'vanguard-statement.pdf',
    parserName: 'vanguard-statement-pdf',
    sourceType: 'statement',
    priority: 50,
    institution: 'Vanguard',
  });
  const activityAccountId = insertSourceAccount(activity.sourceFileId, accountId, 'vanguard-activity-account');
  const statementAccountId = insertSourceAccount(statement.sourceFileId, accountId, 'vanguard-statement-account');

  insertSourceTransaction({
    sourceFileId: activity.sourceFileId,
    sourceAccountId: activityAccountId,
    stableSourceId: 'activity-buy',
    date: '2026-05-16',
    amountCents: -100000,
    description: 'Buy VTSAX',
    priority: 100,
  });
  insertSourceTransaction({
    sourceFileId: statement.sourceFileId,
    sourceAccountId: statementAccountId,
    stableSourceId: 'statement-buy-duplicate',
    date: '2026-05-16',
    amountCents: -100000,
    description: 'Buy VTSAX from statement',
    priority: 50,
  });
  insertSourceTransaction({
    sourceFileId: statement.sourceFileId,
    sourceAccountId: statementAccountId,
    stableSourceId: 'statement-transfer-only',
    date: '2026-05-17',
    amountCents: 250000,
    description: 'In-kind transfer',
    sourceRole: 'statement-only',
    priority: 50,
  });

  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions.map(transaction => transaction.description).sort()).toEqual([
    'Buy VTSAX',
    'In-kind transfer',
  ]);
});

test('source rebuild drops lower-priority statement summaries by activity bucket', () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Merrill Lynch',
    institution: 'Merrill',
    type: 'investment',
    currentBalance: 0,
  }));
  const activity = insertCommittedSourceFile({
    fileName: 'merrill-activity.csv',
    parserName: 'merrill-activity-csv',
    sourceType: 'activity-export',
    priority: 100,
    institution: 'Merrill',
  });
  const statement = insertCommittedSourceFile({
    fileName: 'merrill-statement.pdf',
    parserName: 'merrill-cma-statement-pdf',
    sourceType: 'statement',
    priority: 50,
    institution: 'Merrill',
  });
  const activityAccountId = insertSourceAccount(activity.sourceFileId, accountId, 'merrill-activity-account', {
    institution: 'Merrill',
    sourceAccountName: 'CMA-Edge - 11W-22222',
  });
  const statementAccountId = insertSourceAccount(statement.sourceFileId, accountId, 'merrill-statement-account', {
    institution: 'Merrill',
    sourceAccountName: 'CMA-Edge - 11W-22222',
  });

  insertSourceTransaction({
    sourceFileId: activity.sourceFileId,
    sourceAccountId: activityAccountId,
    stableSourceId: 'detailed-transfer',
    date: '2026-03-05',
    amountCents: -500000,
    description: 'Funds transferred out',
    priority: 100,
  });
  insertSourceTransaction({
    sourceFileId: statement.sourceFileId,
    sourceAccountId: statementAccountId,
    stableSourceId: 'summary-net-cash-flow',
    date: '2026-03-31',
    amountCents: -500000,
    description: 'Statement net cash flow',
    priority: 50,
    raw: {
      type: 'statement-cash-flow-summary',
      metric: 'netCashFlow',
    },
  });
  insertSourceTransaction({
    sourceFileId: statement.sourceFileId,
    sourceAccountId: statementAccountId,
    stableSourceId: 'summary-income',
    date: '2026-03-31',
    amountCents: 12345,
    description: 'Statement dividends/interest income',
    priority: 50,
    raw: {
      type: 'statement-cash-flow-summary',
      metric: 'dividendsInterestIncome',
    },
  });

  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions.map(transaction => transaction.description).sort()).toEqual([
    'Funds transferred out',
    'Statement dividends/interest income',
  ]);
});

test('source rebuild de-duplicates parser-stable money ids across duplicate files', () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Sequoia',
    institution: 'Sequoia Fund',
    type: 'investment',
    currentBalance: 0,
  }));
  const first = insertCommittedSourceFile({
    fileName: 'sequoia-fund-2026-03-31.pdf',
    parserName: 'sequoia-fund-pdf',
    sourceType: 'statement',
    priority: 50,
    institution: 'Sequoia Fund',
  });
  const duplicate = insertCommittedSourceFile({
    fileName: 'hash-sequoia-fund-2026-03-31.pdf',
    parserName: 'sequoia-fund-pdf',
    sourceType: 'statement',
    priority: 50,
    institution: 'Sequoia Fund',
  });
  const firstAccountId = insertSourceAccount(first.sourceFileId, accountId, 'sequoia', {
    institution: 'Sequoia Fund',
    sourceAccountName: 'Sequoia Fund',
  });
  const duplicateAccountId = insertSourceAccount(duplicate.sourceFileId, accountId, 'sequoia', {
    institution: 'Sequoia Fund',
    sourceAccountName: 'Sequoia Fund',
  });

  for (const [sourceFileId, sourceAccountId] of [
    [first.sourceFileId, firstAccountId],
    [duplicate.sourceFileId, duplicateAccountId],
  ] as const) {
    insertSourceTransaction({
      sourceFileId,
      sourceAccountId,
      stableSourceId: `${sourceFileId}-duplicate-purchase`,
      date: '2026-03-15',
      amountCents: 40000,
      description: 'Shares Purchased -ACH',
      priority: 50,
      raw: {
        moneyId: 'sequoia-stable-purchase-id',
      },
    });
  }

  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions).toHaveLength(1);
  expect(ledger.transactions[0]).toMatchObject({
    description: 'Shares Purchased -ACH',
    amount: 400,
  });
});
