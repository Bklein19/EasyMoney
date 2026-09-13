import { beforeEach, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';

process.env.EASYMONEY_DB_PATH = path.join(os.tmpdir(), `easymoney-ledger-rebuild-${process.pid}.sqlite`);

const { getDb, initDatabase, insertRow } = await import('../database.ts');
const { buildLedgerFromSourceFacts, ledgerFingerprint, materializeLedger } = await import('./ledgerRebuild.ts');
const { upsertTransactionAnnotation } = await import('./transactionAnnotations.ts');
const { getTransactionDetails } = await import('./transactionDetails.ts');
const { overlapOccurrenceKey, recordDistinctOverlap } = await import('./reviewedOverlap');

function resetAppTables() {
  const db = getDb();
  initDatabase();
  db.transaction(() => {
    for (const table of [
      'reviewedDistinctOverlaps',
      'parserAnnotationHistory',
      'parserRefreshAccountChoices',
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

test('parser hash collisions preserve occurrences across overlapping exports, statements and accounts', () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Synthetic card', institution: 'Wells Fargo', type: 'credit', currentBalance: 0,
  }));
  const otherAccountId = Number(insertRow('accounts', {
    name: 'Other synthetic card', institution: 'Wells Fargo', type: 'credit', currentBalance: 0,
  }));
  const files: number[] = [];
  for (const [index, count, destination, sourceType] of [
    [0, 2, accountId, 'activity-export'],
    [1, 3, accountId, 'activity-export'],
    [2, 3, accountId, 'statement'],
    [3, 1, otherAccountId, 'activity-export'],
  ] as const) {
    const file = insertCommittedSourceFile({
      fileName: `synthetic-${index}`, parserName: 'synthetic-parser', sourceType,
      priority: 90, institution: 'Wells Fargo',
    });
    files.push(file.sourceFileId);
    const sourceAccountId = insertSourceAccount(file.sourceFileId, destination, `account-${index}`);
    for (let occurrence = 0; occurrence < count; occurrence++) {
      insertSourceTransaction({
        sourceFileId: file.sourceFileId, sourceAccountId,
        stableSourceId: `file-${index}-row-${occurrence}`, date: '2026-06-18',
        amountCents: -500, description: 'SYNTHETIC COFFEE', priority: 90,
        raw: { moneyId: 'same-content-hash', reference: `reference-${occurrence}` },
      });
    }
  }
  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions.filter(t => t.accountId === accountId)).toHaveLength(3);
  expect(ledger.transactions.filter(t => t.accountId === otherAccountId)).toHaveLength(1);
  expect(ledger.provenance).toHaveLength(9);
  const ids = ledger.transactions.filter(t => t.accountId === accountId).map(t => t.ledgerTransactionId);
  materializeLedger(getDb(), ledger);
  upsertTransactionAnnotation(ids[0]!, { notes: 'Preserve repeated purchase note' });
  // Removing the larger export leaves three statement occurrences, not one.
  getDb().prepare("UPDATE sourceFiles SET status = 'unimported' WHERE id IN (?, ?)").run(files[0], files[1]);
  const rebuilt = buildLedgerFromSourceFacts(getDb());
  expect(rebuilt.transactions.filter(t => t.accountId === accountId).map(t => t.ledgerTransactionId)).toEqual(ids);
  materializeLedger(getDb(), rebuilt);
  expect(getTransactionDetails(ids[0]!).transaction.notes).toBe('Preserve repeated purchase note');
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM sourceAccounts WHERE accountId = ?').get(accountId)?.count).toBe(3);
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
  expect(ledger.provenance).toHaveLength(2);
  expect(ledger.provenance?.filter(item => item.selected)).toHaveLength(1);
  expect(ledger.provenance?.find(item => !item.selected)?.reason).toContain('occurrence');
  materializeLedger(getDb(), ledger);
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM ledgerProvenance').get()).toEqual({ count: 2 });
  expect(getDb().prepare('SELECT sourceTransactionId FROM ledgerTransactions').get()?.sourceTransactionId).toBeGreaterThan(0);
  const detail = getTransactionDetails(ledger.transactions[0]!.ledgerTransactionId);
  expect(detail.sources.map(source => source.fileName).sort()).toEqual(['checking-a.csv', 'checking-b.csv']);
  expect(detail.sources.every(source => source.mappedAccountName === 'WF Checking')).toBe(true);
  upsertTransactionAnnotation(ledger.transactions[0]!.ledgerTransactionId, { notes: 'Preserve this note' });
  getDb().prepare("UPDATE sourceFiles SET status = 'unimported' WHERE id = ?").run(exportA.sourceFileId);
  materializeLedger(getDb(), buildLedgerFromSourceFacts(getDb()));
  const remaining = getTransactionDetails(ledger.transactions[0]!.ledgerTransactionId);
  expect(remaining.transaction.notes).toBe('Preserve this note');
  expect(remaining.sources.map(source => source.fileName)).toEqual(['checking-b.csv']);
  expect(getDb().prepare('SELECT accountId FROM sourceAccounts WHERE id = ?').get(accountA)?.accountId).toBe(accountId);
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

test('source rebuild reconciles statement posting-date drift without collapsing duplicate occurrences', () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Example Credit Card',
    institution: 'Example Bank',
    type: 'credit',
    currentBalance: 0,
  }));
  const activity = insertCommittedSourceFile({
    fileName: 'credit-card.csv',
    parserName: 'credit-card-csv',
    sourceType: 'activity-export',
    priority: 10,
    institution: 'Example Bank',
  });
  const statement = insertCommittedSourceFile({
    fileName: 'credit-card-statement.pdf',
    parserName: 'credit-card-statement-pdf',
    sourceType: 'statement',
    priority: 50,
    institution: 'Example Bank',
  });
  const activityAccount = insertSourceAccount(activity.sourceFileId, accountId, 'activity-card');
  const statementAccount = insertSourceAccount(statement.sourceFileId, accountId, 'statement-card');

  insertSourceTransaction({
    sourceFileId: activity.sourceFileId,
    sourceAccountId: activityAccount,
    stableSourceId: 'activity-pact',
    date: '2026-06-04T00:00:00.000Z',
    amountCents: -14370,
    description: 'WEAR PACT, LLC 800-662-7228 CO',
    priority: 10,
  });
  insertSourceTransaction({
    sourceFileId: statement.sourceFileId,
    sourceAccountId: statementAccount,
    stableSourceId: 'statement-pact',
    date: '2026-06-05',
    amountCents: -14370,
    description: 'WEAR PACT, LLC 800-662-7228 CO',
    priority: 50,
  });

  for (const suffix of ['first', 'second']) {
    insertSourceTransaction({
      sourceFileId: activity.sourceFileId,
      sourceAccountId: activityAccount,
      stableSourceId: `activity-rent-${suffix}`,
      date: '2026-06-08T00:00:00.000Z',
      amountCents: -3500,
      description: 'ZG * RENTAPPLICATION 206-516-2265 WA',
      priority: 10,
    });
    insertSourceTransaction({
      sourceFileId: statement.sourceFileId,
      sourceAccountId: statementAccount,
      stableSourceId: `statement-rent-${suffix}`,
      date: '2026-06-08',
      amountCents: -3500,
      description: 'ZG * RENTAPPLICATION 206-516-2265 WA',
      priority: 50,
    });
  }

  for (const [source, sourceAccountId, stableSourceId, date] of [
    [activity, activityAccount, 'activity-coffee', '2026-06-15T00:00:00.000Z'],
    [statement, statementAccount, 'statement-coffee', '2026-06-19'],
  ] as const) {
    insertSourceTransaction({
      sourceFileId: source.sourceFileId,
      sourceAccountId,
      stableSourceId,
      date,
      amountCents: -500,
      description: 'EXAMPLE COFFEE',
      priority: source === activity ? 10 : 50,
    });
  }

  const ledger = buildLedgerFromSourceFacts(getDb());
  const pact = ledger.transactions.filter(transaction => transaction.description.includes('WEAR PACT'));
  const rent = ledger.transactions.filter(transaction => transaction.description.includes('RENTAPPLICATION'));
  const coffee = ledger.transactions.filter(transaction => transaction.description === 'EXAMPLE COFFEE');

  expect(pact.map(transaction => transaction.date)).toEqual(['2026-06-04']);
  expect(rent).toHaveLength(2);
  expect(rent.map(transaction => transaction.occurrenceIndex).sort()).toEqual([0, 1]);
  expect(coffee.map(transaction => transaction.date).sort()).toEqual([
    '2026-06-15',
    '2026-06-19',
  ]);
});

test('source rebuild uses parser-provided Robinhood identities across CSV and statement descriptions', () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Robinhood Gold Card',
    institution: 'Robinhood',
    type: 'credit',
    currentBalance: 0,
  }));
  const activity = insertCommittedSourceFile({
    fileName: 'robinhood.csv',
    parserName: 'robinhood-credit-card-csv',
    sourceType: 'activity-export',
    priority: 10,
    institution: 'Robinhood',
  });
  const statement = insertCommittedSourceFile({
    fileName: 'robinhood-statement.pdf',
    parserName: 'robinhood-credit-card-statement-pdf',
    sourceType: 'statement',
    priority: 50,
    institution: 'Robinhood',
  });
  const activityAccount = insertSourceAccount(activity.sourceFileId, accountId, 'activity-card', { institution: 'Robinhood' });
  const statementAccount = insertSourceAccount(statement.sourceFileId, accountId, 'statement-card', { institution: 'Robinhood' });

  insertSourceTransaction({
    sourceFileId: activity.sourceFileId,
    sourceAccountId: activityAccount,
    stableSourceId: 'activity-instacart',
    date: '2026-08-01',
    amountCents: -4200,
    description: 'INSTACART.COMCA',
    priority: 10,
    raw: { crossSourceIdentity: 'robinhood-credit:instacartcomca' },
  });
  insertSourceTransaction({
    sourceFileId: statement.sourceFileId,
    sourceAccountId: statementAccount,
    stableSourceId: 'statement-instacart',
    date: '2026-08-02',
    amountCents: -4200,
    description: 'INSTACART.COM CA',
    priority: 50,
    raw: { crossSourceIdentity: 'robinhood-credit:instacartcomca' },
  });

  const ledger = buildLedgerFromSourceFacts(getDb());

  expect(ledger.transactions).toHaveLength(1);
  expect(ledger.transactions[0]?.description).toBe('INSTACART.COMCA');
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

test('same-account/date/amount cross-format overlap uses source priority despite different descriptions', () => {
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
    date: '2026-05-16T07:00:00.000Z',
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
  expect(ledger.ambiguities).toHaveLength(0);
  expect(ledger.provenance?.filter(item => !item.selected)).toHaveLength(1);
});

test('priority matching preserves excess document occurrences including blank descriptions', () => {
  const accountId = Number(insertRow('accounts', { name: 'Example', institution: 'Example', type: 'credit', currentBalance: 0 }));
  const sources = ['activity-export', 'statement'].map((sourceType, index) => {
    const file = insertCommittedSourceFile({ fileName: `occurrences-${index}`, parserName: 'example', sourceType, priority: index ? 1 : 100, institution: 'Example' });
    return { ...file, sourceAccountId: insertSourceAccount(file.sourceFileId, accountId, `account-${index}`) };
  });
  for (const [index, source] of sources.entries()) {
    for (let occurrence = 0; occurrence < index + 1; occurrence++) {
      insertSourceTransaction({ ...source, stableSourceId: `${index}-${occurrence}`, date: '2026-05-01', amountCents: -500, description: 'COFFEE', priority: index ? 1 : 100 });
    }
    insertSourceTransaction({ ...source, stableSourceId: `${index}-blank`, date: '2026-05-01', amountCents: -700, description: '', priority: index ? 1 : 100 });
  }
  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions.filter(row => row.amount === -5)).toHaveLength(2);
  expect(ledger.transactions.filter(row => row.amount === -7)).toHaveLength(1);
  expect(ledger.provenance).toHaveLength(5);
  expect(ledger.provenance?.filter(row => !row.selected)).toHaveLength(2);
  expect(ledger.ambiguities).toHaveLength(0);
});

test('equidistant posting dates are ambiguous instead of arbitrarily selected', () => {
  const accountId = Number(insertRow('accounts', { name: 'Example', institution: 'Example', type: 'credit', currentBalance: 0 }));
  for (const [index, sourceType] of ['activity-export', 'statement'].entries()) {
    const source = insertCommittedSourceFile({ fileName: `drift-${index}`, parserName: 'example', sourceType, priority: 50, institution: 'Example' });
    const sourceAccountId = insertSourceAccount(source.sourceFileId, accountId, `account-${index}`);
    for (const date of index ? ['2026-05-02'] : ['2026-05-01', '2026-05-03']) {
      insertSourceTransaction({ ...source, sourceAccountId, stableSourceId: `${index}-${date}`, date, amountCents: -500, description: 'COFFEE', priority: 50 });
    }
  }
  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions).toHaveLength(3);
  expect(ledger.ambiguities).toHaveLength(3);
  expect(ledger.provenance?.every(row => row.selected)).toBe(true);
  expect(buildLedgerFromSourceFacts(getDb())).toEqual(ledger);
});

test('cross-format occurrence budgets use original documents before same-format dedupe', () => {
  const accountId = Number(insertRow('accounts', { name:'Example', institution:'Example', type:'checking' }));
  const descriptions = [['A','A','B'], ['A','B','B'], ['Statement detail','Statement detail','Statement detail']];
  for (const [index, rows] of descriptions.entries()) {
    const file = insertCommittedSourceFile({fileName:`budget-${index}`,parserName:'example',sourceType:index===2?'statement':'activity-export',priority:100,institution:'Example'});
    const sourceAccountId = insertSourceAccount(file.sourceFileId,accountId,`account-${index}`);
    for (const [occurrence, description] of rows.entries()) insertSourceTransaction({...file,sourceAccountId,stableSourceId:`${index}-${occurrence}`,date:'2026-05-01',amountCents:-500,description,priority:100});
  }
  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions).toHaveLength(3);
  expect(ledger.provenance).toHaveLength(9);
  expect(ledger.provenance?.filter(row=>!row.selected)).toHaveLength(6);
  expect(ledger.ambiguities).toHaveLength(0);
  expect(buildLedgerFromSourceFacts(getDb())).toEqual(ledger);
});

test('same-day excess occurrences cannot be consumed again by posting-date drift matching', () => {
  const accountId = Number(insertRow('accounts', { name:'Example', institution:'Example', type:'checking' }));
  for (const [index, dates] of [['2026-05-01','2026-05-02'],['2026-05-01','2026-05-01']].entries()) {
    const file = insertCommittedSourceFile({fileName:`double-match-${index}`,parserName:'example',sourceType:index?'statement':'activity-export',priority:100,institution:'Example'});
    const sourceAccountId = insertSourceAccount(file.sourceFileId,accountId,`account-${index}`);
    for (const [occurrence,date] of dates.entries()) insertSourceTransaction({...file,sourceAccountId,stableSourceId:`${index}-${occurrence}`,date,amountCents:-500,description:'Coffee',priority:100});
  }
  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions).toHaveLength(3);
  expect(ledger.transactions.filter(row=>row.date.startsWith('2026-05-01'))).toHaveLength(2);
});

test.each(['same','security','quantity','action','settlement','missing'] as const)('structured trade matching uses both dates and full identity: %s', difference => {
  const accountId = Number(insertRow('accounts', {name:'Trade test',institution:'Example',type:'investment'}));
  for (const [index,sourceType] of ['activity-export','statement'].entries()) {
    const file=insertCommittedSourceFile({fileName:`trade-${index}`,parserName:'example',sourceType,priority:100,institution:'Example'});
    const sourceAccountId=insertSourceAccount(file.sourceFileId,accountId,`account-${index}`);
    const trade={tradeDate:'2026-05-01',settlementDate:'2026-05-04',symbol:'TEST',quantity:'2.50',action:'buy'};
    if(index) {
      if(difference==='security')trade.symbol='OTHER';
      if(difference==='quantity')trade.quantity='3';
      if(difference==='action')trade.action='sell';
      if(difference==='settlement')trade.settlementDate='2026-05-05';
    }
    for(let occurrence=0;occurrence<(index?1:2);occurrence++) insertSourceTransaction({...file,sourceAccountId,stableSourceId:`trade-${index}-${occurrence}`,date:index?'2026-05-04':'2026-05-01',amountCents:-10000,description:index?'Statement wording':'Activity wording',priority:100,raw:index&&difference==='missing'?{}:{securityTrade:trade}});
  }
  const ledger=buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions).toHaveLength(difference==='same'?2:3);
  expect(ledger.provenance?.filter(p=>!p.selected)).toHaveLength(difference==='same'?1:0);
  if(difference==='same') {
    expect(ledger.transactions.every(t=>t.date==='2026-05-01')).toBe(true);
    expect(ledger.ambiguities).toHaveLength(0);
  }
});

test('four airline bag fees remain four purchases while the statement/export copies reconcile', () => {
  const accountId=Number(insertRow('accounts',{name:'Card',institution:'Example',type:'credit'}));
  for(const [index,sourceType,date,description] of [
    [0,'statement','2026-03-19','Airline A bags'],
    [1,'activity-export','2026-03-20','Airline B bags'],
    [2,'statement','2026-03-20','Airline B bags itinerary detail'],
  ] as const){
    const file=insertCommittedSourceFile({fileName:`bags-${index}`,parserName:'example',sourceType,priority:100,institution:'Example'});
    const sourceAccountId=insertSourceAccount(file.sourceFileId,accountId,`account-${index}`);
    for(let occurrence=0;occurrence<2;occurrence++)insertSourceTransaction({...file,sourceAccountId,stableSourceId:`${index}-${occurrence}`,date,amountCents:-3500,description,priority:100});
  }
  const ledger=buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions).toHaveLength(4);
  expect(ledger.transactions.filter(t=>t.date.startsWith('2026-03-19'))).toHaveLength(2);
  expect(ledger.transactions.filter(t=>t.date.startsWith('2026-03-20'))).toHaveLength(2);
  expect(ledger.ambiguities!.length).toBeGreaterThan(0);
  for(const warning of ledger.ambiguities!) for(const candidateId of warning.candidateSourceTransactionIds) {
    recordDistinctOverlap(getDb(),overlapOccurrenceKey(getDb(),warning.sourceTransactionId),overlapOccurrenceKey(getDb(),candidateId),'Source review confirmed four distinct bag charges.');
  }
  const reviewed=buildLedgerFromSourceFacts(getDb());
  expect(reviewed.ambiguities).toHaveLength(0);
  expect(ledgerFingerprint(reviewed)).toBe(ledgerFingerprint(ledger));
  getDb().prepare('UPDATE sourceTransactions SET description=? WHERE id=?').run('Changed source evidence',ledger.ambiguities![0]!.sourceTransactionId);
  expect(buildLedgerFromSourceFacts(getDb()).ambiguities!.length).toBeGreaterThan(0);
});

test('source rebuild excludes legacy statement summaries even without corresponding detail', () => {
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
    sourceRole: 'statement-summary',
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
  ]);
  expect(ledger.exclusions).toHaveLength(2);
  expect(ledger.provenance).toHaveLength(1);
});

test('conflicting equal-rank same-date balances have no arbitrary winner and block materialization', () => {
  const accountId = Number(insertRow('accounts', { name: 'Example', institution: 'Example', type: 'investment', currentBalance: 0 }));
  for (const [index, balanceCents] of [10000, 11000].entries()) {
    const source = insertCommittedSourceFile({ fileName: `balance-${index}`, parserName: 'example', sourceType: 'statement', priority: 50, institution: 'Example' });
    const sourceAccountId = insertSourceAccount(source.sourceFileId, accountId, `account-${index}`);
    insertSourceBalance({ ...source, sourceAccountId, date: index ? '2026-05-31T00:00:00.000Z' : '2026-05-31', balanceCents, priority: 50 });
  }
  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.balanceSnapshots).toHaveLength(0);
  expect(ledger.balanceConflicts).toHaveLength(1);
  expect(ledger.balanceConflicts?.[0]?.balanceCents).toEqual([10000, 11000]);
  expect(() => materializeLedger(getDb(), ledger)).toThrow('conflicting same-date balances');
  getDb().prepare('UPDATE sourceBalances SET balanceCents = 10000').run();
  const reconciled = buildLedgerFromSourceFacts(getDb());
  expect(reconciled.balanceConflicts).toHaveLength(0);
  expect(reconciled.balanceSnapshots).toHaveLength(1);
  expect(reconciled.balanceSnapshots[0]?.capturedAt).toBe('2026-05-31T00:00:00.000Z');
});

test('all legacy aggregate transaction shapes are excluded without deleting source facts', () => {
  const accountId = Number(insertRow('accounts', { name: 'Example', institution: 'Example', type: 'investment', currentBalance: 0 }));
  const source = insertCommittedSourceFile({ fileName: 'summary.pdf', parserName: 'example', sourceType: 'statement', priority: 50, institution: 'Example' });
  const sourceAccountId = insertSourceAccount(source.sourceFileId, accountId, 'account');
  const rawShapes = [
    { source: 'tiaa-statement-summary' }, { source: '401k-statement-summary' },
    { source: 'fidelity-netbenefits-statement-summary' },
    { source: 'fidelity-portfolio-statement', type: 'securities-transferred-out' },
  ];
  rawShapes.forEach((raw, index) => insertSourceTransaction({ ...source, sourceAccountId, stableSourceId: `summary-${index}`, date: '2026-05-31', amountCents: 100, description: 'Aggregate', priority: 50, raw }));
  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions).toHaveLength(0);
  expect(ledger.exclusions).toHaveLength(4);
  expect((getDb().prepare('SELECT COUNT(*) AS count FROM sourceTransactions').get() as { count: number }).count).toBe(4);
});

test('overlapping statement documents keep maximum identical occurrence count, never the sum', () => {
  const accountId = Number(insertRow('accounts', { name: 'Example', institution: 'Example', type: 'credit', currentBalance: 0 }));
  for (const [index, count] of [2, 3].entries()) {
    const source = insertCommittedSourceFile({ fileName: `statement-${index}`, parserName: 'example', sourceType: 'statement', priority: 50, institution: 'Example' });
    const sourceAccountId = insertSourceAccount(source.sourceFileId, accountId, `account-${index}`);
    for (let occurrence = 0; occurrence < count; occurrence++) {
      insertSourceTransaction({ ...source, sourceAccountId, stableSourceId: `${index}-${occurrence}`, date: index ? '2026-05-01T00:00:00.000Z' : '2026-05-01', amountCents: -500, description: 'COFFEE', priority: 50 });
    }
  }
  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions).toHaveLength(3);
  expect(ledger.transactions.every(row => row.date === '2026-05-01')).toBe(true);
  expect(ledger.provenance).toHaveLength(5);
});

test('maximum multiplicity uses original document rows before shared parser identities and ignores priority', () => {
  const accountId = Number(insertRow('accounts', { name: 'Example', institution: 'Example', type: 'credit', currentBalance: 0 }));
  for (const [index, count] of [2, 5].entries()) {
    const source = insertCommittedSourceFile({ fileName: `original-${index}`, parserName: 'example', sourceType: 'activity-export', priority: index ? 1 : 100, institution: 'Example' });
    const sourceAccountId = insertSourceAccount(source.sourceFileId, accountId, `account-${index}`);
    for (let occurrence = 0; occurrence < count; occurrence++) {
      insertSourceTransaction({ ...source, sourceAccountId, stableSourceId: `${index}-${occurrence}`, date: '2026-05-01', amountCents: -500, description: 'COFFEE', priority: index ? 1 : 100, raw: { moneyId: `identity-${occurrence}` } });
    }
  }
  const ledger = buildLedgerFromSourceFacts(getDb());
  expect(ledger.transactions).toHaveLength(5);
  expect(ledger.provenance).toHaveLength(7);
  expect(ledger.provenance?.filter(row => !row.selected)).toHaveLength(2);
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
