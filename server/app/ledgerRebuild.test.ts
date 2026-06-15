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
      'transactionAnnotations',
      'transactions',
      'balanceSnapshots',
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

function insertSourceAccount(sourceFileId: number, accountId: number, sourceAccountKey: string) {
  return Number(insertRow('sourceAccounts', {
    sourceFileId,
    accountId,
    institution: 'Vanguard',
    sourceAccountKey,
    sourceAccountName: 'Roth IRA brokerage account-XXXX0000',
    rawJson: JSON.stringify({ account: 'Roth IRA brokerage account-XXXX0000' }),
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
});
