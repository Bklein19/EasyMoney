import Papa from 'papaparse';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDb, hashContent, insertRow, updateRow } from '../database.ts';
import type { CommitImportTransaction, ImportAccountMapping, ImportPreviewTransaction, ImportProfile, ParsedImportBalance, ParsedImportTransaction } from './importTypes.ts';
import { CUSTOM_CSV_PARSER_ID, parseCustomCsv } from './importParsers/customCsv.ts';
import { mappingFromProfile } from './importParsers/csvMapping.ts';
import { resolveImportParser } from './importParsers/index.ts';
import { buildLedgerFromSourceFacts, materializeLedger } from './ledgerRebuild.ts';
import { assignLedgerTransactionIdentities, getLedgerTransactionBaseKey } from './transactionIdentity.ts';

interface PreviewImportOptions {
  fileName: string;
  text: string;
  fileBytes?: Uint8Array;
  customProfile?: ImportProfile | null;
}

type ImportTransactionInput = Partial<ImportPreviewTransaction> & {
  date: string;
  amount: number;
};

type AccountMappingDecision =
  | { sourceAccountId: number; mode?: 'existing'; accountId: number | null }
  | { sourceAccountId: number; mode: 'auto'; accountId?: number | null }
  | { sourceAccountId: number; mode: 'unarchive'; accountId: number }
  | {
      sourceAccountId: number;
      mode: 'create';
      account: {
        name?: string | null;
        institution?: string | null;
        type?: string | null;
        currency?: string | null;
        accountHolder?: string | null;
      };
    };

interface CommitImportOptions {
  accountId?: number | null;
  importFileId?: number | null;
  importRowIds?: number[] | null;
  forceImportRowIds?: number[] | null;
  balanceRowIds?: number[] | null;
  transactions?: ImportTransactionInput[];
  accountMappings?: AccountMappingDecision[] | null;
  importMeta?: {
    importFileId?: number | null;
    headers?: string[];
    profile?: ImportProfile | null;
    mapping?: Record<string, unknown> | null;
    profileName?: string | null;
    accountMappings?: AccountMappingDecision[] | null;
  } | null;
  rebuildLedger?: boolean;
}

export interface ImportHistoryItem {
  id: number;
  fileName: string;
  parserName: string | null;
  institution: string | null;
  status: string | null;
  rowCount: number | null;
  sourceType: string | null;
  importBatchId: string | null;
  createdAt: string | null;
  committedAt: string | null;
  transactionCount: number;
  balanceCount: number;
  unresolvedSourceAccountCount: number;
}

interface MaterializeImportTransactionsOptions {
  accountId?: number | null;
  importFileId?: number | null;
  importRowIds?: number[] | null;
  forceImportRowIds?: number[] | null;
  balanceRowIds?: number[] | null;
  transactions?: ImportTransactionInput[];
  accountMappings?: AccountMappingDecision[] | null;
  fallbackImportFileId?: number | null;
}

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function normalizeAmount(value: unknown) {
  return Number(value || 0).toFixed(2);
}

function dollarsFromCents(value: number) {
  return Math.round(value) / 100;
}

function getHeaderSignature(headers: string[] = []) {
  return headers.map(header => normalizeText(header)).join('|');
}

function getTransactionFingerprint(transaction: ImportTransactionInput, accountId: number) {
  const text = normalizeText(
    transaction.originalDescription ||
    transaction.description ||
    transaction.merchant ||
    ''
  );
  return [
    accountId,
    normalizeDate(transaction.date),
    normalizeAmount(transaction.amount),
    text,
  ].join('|');
}

function getMaterializedImportBatchId(fingerprint: string) {
  return `import-row-${hashContent(fingerprint).slice(0, 16)}`;
}

function importFileHasSourceFacts(importFileId: number | null | undefined) {
  if (!importFileId) return false;
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM sourceFiles sf
    LEFT JOIN sourceTransactions st ON st.sourceFileId = sf.id
    LEFT JOIN sourceBalances sb ON sb.sourceFileId = sf.id
    WHERE sf.importFileId = ?
      AND (st.id IS NOT NULL OR sb.id IS NOT NULL)
  `).get(importFileId) as { count: number };
  return row.count > 0;
}

export function listImportHistory(): ImportHistoryItem[] {
  return getDb().prepare(`
    SELECT
      ifs.id,
      ifs.fileName,
      ifs.parserName,
      ifs.institution,
      ifs.status,
      ifs.rowCount,
      ifs.sourceType,
      ifs.importBatchId,
      ifs.createdAt,
      ifs.committedAt,
      COUNT(DISTINCT lt.id) AS transactionCount,
      COUNT(DISTINCT lb.id) AS balanceCount,
      COUNT(DISTINCT CASE
        WHEN sa.accountId IS NULL AND (st.id IS NOT NULL OR sb.id IS NOT NULL) THEN sa.id
        ELSE NULL
      END) AS unresolvedSourceAccountCount
    FROM importFiles ifs
    LEFT JOIN ledgerTransactions lt ON lt.importFileId = ifs.id
    LEFT JOIN importRows irb ON irb.importFileId = ifs.id AND irb.rowType = 'balance'
    LEFT JOIN sourceBalances sb ON sb.importRowId = irb.id
    LEFT JOIN sourceFiles sf ON sf.importFileId = ifs.id
    LEFT JOIN sourceAccounts sa ON sa.sourceFileId = sf.id
    LEFT JOIN sourceTransactions st ON st.sourceAccountId = sa.id
    LEFT JOIN ledgerBalances lb ON lb.sourceBalanceId = sb.id
    GROUP BY ifs.id
    ORDER BY COALESCE(ifs.committedAt, ifs.createdAt) DESC, ifs.id DESC
  `).all() as ImportHistoryItem[];
}

export function unimportFile(importFileId: number | string) {
  const id = Number(importFileId);
  if (!Number.isFinite(id)) throw new Error('Invalid import file id');

  const db = getDb();
  const importFile = db.prepare('SELECT * FROM importFiles WHERE id = ?').get(id) as
    | { id: number; status?: string | null }
    | undefined;
  if (!importFile) throw new Error(`Import file not found: ${id}`);

  db.transaction(() => {
    db.prepare(`
      UPDATE importRows
      SET transactionId = NULL, fingerprint = NULL
      WHERE importFileId = ?
    `).run(id);
    db.prepare(`
      UPDATE sourceFiles
      SET status = 'unimported', committedAt = NULL
      WHERE importFileId = ?
    `).run(id);
    db.prepare(`
      UPDATE importFiles
      SET status = 'unimported', importBatchId = NULL, committedAt = NULL
      WHERE id = ?
    `).run(id);
  })();

  materializeLedger(db, buildLedgerFromSourceFacts(db));
  return { ok: true, importFileId: id };
}

export function reimportFile(importFileId: number | string) {
  const id = Number(importFileId);
  if (!Number.isFinite(id)) throw new Error('Invalid import file id');

  const db = getDb();
  const importFile = db.prepare('SELECT * FROM importFiles WHERE id = ?').get(id) as
    | { id: number; status?: string | null }
    | undefined;
  if (!importFile) throw new Error(`Import file not found: ${id}`);
  if (importFile.status !== 'unimported') throw new Error(`Import file is not unimported: ${id}`);

  const facts = db.prepare(`
    SELECT
      COUNT(DISTINCT sf.id) AS sourceFileCount,
      COUNT(DISTINCT st.id) AS transactionCount,
      COUNT(DISTINCT sb.id) AS balanceCount,
      SUM(CASE
        WHEN (st.id IS NOT NULL OR sb.id IS NOT NULL) AND sa.accountId IS NULL THEN 1
        ELSE 0
      END) AS unresolvedFactCount
    FROM sourceFiles sf
    LEFT JOIN sourceAccounts sa ON sa.sourceFileId = sf.id
    LEFT JOIN sourceTransactions st ON st.sourceAccountId = sa.id
    LEFT JOIN sourceBalances sb ON sb.sourceAccountId = sa.id
    WHERE sf.importFileId = ?
  `).get(id) as {
    sourceFileCount: number;
    transactionCount: number;
    balanceCount: number;
    unresolvedFactCount: number | null;
  };
  if (!facts.sourceFileCount || (!facts.transactionCount && !facts.balanceCount)) {
    throw new Error(`Import file has no saved source facts: ${id}`);
  }
  if (Number(facts.unresolvedFactCount || 0) > 0) {
    throw new Error('Cannot reimport while source accounts are unresolved.');
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      UPDATE importRows
      SET transactionId = NULL, fingerprint = NULL
      WHERE importFileId = ?
    `).run(id);
    db.prepare(`
      UPDATE sourceFiles
      SET status = 'committed', committedAt = @committedAt
      WHERE importFileId = @importFileId
    `).run({
      importFileId: id,
      committedAt: now,
    });
    db.prepare(`
      UPDATE importFiles
      SET status = 'committed',
          importBatchId = COALESCE(importBatchId, @importBatchId),
          committedAt = @committedAt
      WHERE id = @importFileId
    `).run({
      importFileId: id,
      importBatchId: `reimport-${id}-${hashContent(now).slice(0, 12)}`,
      committedAt: now,
    });
  })();

  const materialized = materializeLedger(db, buildLedgerFromSourceFacts(db));
  return { ok: true, importFileId: id, ...materialized };
}

function normalizeImportFileIds(importFileIds: Array<number | string> | undefined | null) {
  return [...new Set((importFileIds || []).map(Number))].filter(Number.isFinite);
}

export function unimportFiles(importFileIds: Array<number | string> | undefined | null) {
  const ids = normalizeImportFileIds(importFileIds);
  if (ids.length === 0) return { ok: true, importFileIds: [], count: 0 };

  const db = getDb();
  const found = db.prepare(`
    SELECT id
    FROM importFiles
    WHERE id = ?
  `);
  const missing = ids.filter(id => !found.get(id));
  if (missing.length > 0) throw new Error(`Import file not found: ${missing[0]}`);

  db.transaction(() => {
    for (const id of ids) {
      db.prepare(`
        UPDATE importRows
        SET transactionId = NULL, fingerprint = NULL
        WHERE importFileId = ?
      `).run(id);
      db.prepare(`
        UPDATE sourceFiles
        SET status = 'unimported', committedAt = NULL
        WHERE importFileId = ?
      `).run(id);
      db.prepare(`
        UPDATE importFiles
        SET status = 'unimported', importBatchId = NULL, committedAt = NULL
        WHERE id = ?
      `).run(id);
    }
  })();

  materializeLedger(db, buildLedgerFromSourceFacts(db));
  return { ok: true, importFileIds: ids, count: ids.length };
}

export function reimportFiles(importFileIds: Array<number | string> | undefined | null) {
  const ids = normalizeImportFileIds(importFileIds);
  if (ids.length === 0) return { ok: true, importFileIds: [], count: 0, transactionCount: 0, balanceCount: 0 };

  const db = getDb();
  const importFileStatement = db.prepare('SELECT * FROM importFiles WHERE id = ?');
  const factStatement = db.prepare(`
    SELECT
      COUNT(DISTINCT sf.id) AS sourceFileCount,
      COUNT(DISTINCT st.id) AS transactionCount,
      COUNT(DISTINCT sb.id) AS balanceCount,
      SUM(CASE
        WHEN (st.id IS NOT NULL OR sb.id IS NOT NULL) AND sa.accountId IS NULL THEN 1
        ELSE 0
      END) AS unresolvedFactCount
    FROM sourceFiles sf
    LEFT JOIN sourceAccounts sa ON sa.sourceFileId = sf.id
    LEFT JOIN sourceTransactions st ON st.sourceAccountId = sa.id
    LEFT JOIN sourceBalances sb ON sb.sourceAccountId = sa.id
    WHERE sf.importFileId = ?
  `);

  for (const id of ids) {
    const importFile = importFileStatement.get(id) as { id: number; status?: string | null } | undefined;
    if (!importFile) throw new Error(`Import file not found: ${id}`);
    if (importFile.status !== 'unimported') throw new Error(`Import file is not unimported: ${id}`);

    const facts = factStatement.get(id) as {
      sourceFileCount: number;
      transactionCount: number;
      balanceCount: number;
      unresolvedFactCount: number | null;
    };
    if (!facts.sourceFileCount || (!facts.transactionCount && !facts.balanceCount)) {
      throw new Error(`Import file has no saved source facts: ${id}`);
    }
    if (Number(facts.unresolvedFactCount || 0) > 0) {
      throw new Error(`Cannot reimport while source accounts are unresolved: ${id}`);
    }
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    for (const id of ids) {
      db.prepare(`
        UPDATE importRows
        SET transactionId = NULL, fingerprint = NULL
        WHERE importFileId = ?
      `).run(id);
      db.prepare(`
        UPDATE sourceFiles
        SET status = 'committed', committedAt = @committedAt
        WHERE importFileId = @importFileId
      `).run({
        importFileId: id,
        committedAt: now,
      });
      db.prepare(`
        UPDATE importFiles
        SET status = 'committed',
            importBatchId = COALESCE(importBatchId, @importBatchId),
            committedAt = @committedAt
        WHERE id = @importFileId
      `).run({
        importFileId: id,
        importBatchId: `reimport-${id}-${hashContent(`${now}|${ids.join(',')}`).slice(0, 12)}`,
        committedAt: now,
      });
    }
  })();

  const materialized = materializeLedger(db, buildLedgerFromSourceFacts(db));
  return { ok: true, importFileIds: ids, count: ids.length, ...materialized };
}

function getStableSourceTransactionId(importFileId: number, transaction: ParsedImportTransaction) {
  return `src_txn_${hashContent([
    importFileId,
    transaction.sourceRowIndex,
    transaction.date,
    transaction.amountCents,
    normalizeText(transaction.description),
    transaction.sourceRole,
  ].join('|')).slice(0, 32)}`;
}

function isCreditAccount(account: { type?: string | null } | undefined) {
  return account?.type === 'credit' || account?.type === 'credit_card' || account?.type === 'credit-card';
}

function inferAccountType(name: string | null, fallbackType?: string | null) {
  if (fallbackType) return fallbackType;
  const normalized = normalizeText(name || '');
  if (/\b(credit|card|visa|mastercard|amex|discover)\b/.test(normalized)) return 'credit';
  if (/\b(savings|save)\b/.test(normalized)) return 'savings';
  if (/\b(ira|roth|brokerage|investment|merrill|robinhood|vanguard|retirement|annuity)\b/.test(normalized)) return 'investment';
  if (/\b(checking|chk)\b/.test(normalized)) return 'checking';
  return 'other';
}

function normalizeAccountStatus(status: string | null | undefined) {
  return status || 'active';
}

function normalizeAccountCreateInput(mapping: Extract<AccountMappingDecision, { mode: 'create' }>, sourceAccount: {
  institution: string | null;
  sourceAccountName: string | null;
  accountHolder?: string | null;
}) {
  const input = mapping.account || {};
  const sourceName = sourceAccount.sourceAccountName && sourceAccount.sourceAccountName !== 'Selected account'
    ? sourceAccount.sourceAccountName
    : null;
  const name = String(input.name || sourceName || '').trim();
  if (!name) throw new Error('Account name is required for import-created accounts.');
  const institution = input.institution === null || input.institution === undefined
    ? sourceAccount.institution || null
    : String(input.institution).trim() || null;
  const type = String(input.type || inferAccountType(name)).trim();
  const currency = String(input.currency || 'USD').trim().toUpperCase();
  const accountHolder = input.accountHolder === null || input.accountHolder === undefined
    ? sourceAccount.accountHolder || null
    : String(input.accountHolder).trim() || null;
  if (!type) throw new Error('Account type is required for import-created accounts.');
  if (!currency) throw new Error('Account currency is required for import-created accounts.');
  return { name, institution, type, currency, accountHolder };
}

function createAccountForSourceMapping(mapping: Extract<AccountMappingDecision, { mode: 'create' }>, sourceAccount: {
  institution: string | null;
  sourceAccountName: string | null;
  accountHolder?: string | null;
}) {
  const now = new Date().toISOString();
  const account = normalizeAccountCreateInput(mapping, sourceAccount);
  return Number(insertRow('accounts', {
    ...account,
    currentBalance: 0,
    status: 'active',
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }));
}

function upsertAccountAlias(sourceAccount: {
  id: number;
  institution: string | null;
  sourceAccountName: string | null;
}, accountId: number) {
  const alias = (sourceAccount.sourceAccountName || '').trim();
  if (!alias || alias === 'Selected account') return;

  const institution = (sourceAccount.institution || 'Unknown Institution').trim();
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO accountAliases (institution, alias, accountId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(institution, alias) DO UPDATE SET
      accountId = excluded.accountId,
      updatedAt = excluded.updatedAt
  `).run(institution, alias, accountId, now, now);
}

function applySourceAccountHolder(sourceAccount: { accountHolder?: string | null }, accountId: number | null) {
  const accountHolder = sourceAccount.accountHolder?.trim();
  if (!accountHolder || !accountId) return;
  getDb().prepare(`
    UPDATE accounts
    SET accountHolder = @accountHolder,
        updatedAt = @updatedAt
    WHERE id = @accountId
      AND (accountHolder IS NULL OR TRIM(accountHolder) = '')
  `).run({
    accountId,
    accountHolder,
    updatedAt: new Date().toISOString(),
  });
}

function linkSourceAccount(sourceAccountId: number, accountId: number | null, options: { allowArchived?: boolean } = {}) {
  const db = getDb();
  if (accountId !== null) {
    const account = db.prepare('SELECT id, status FROM accounts WHERE id = ?').get(accountId) as
      | { id: number; status: string | null }
      | undefined;
    if (!account) throw new Error(`Account not found: ${accountId}`);
    if (!options.allowArchived && normalizeAccountStatus(account.status) === 'archived') {
      throw new Error(`Account is archived: ${accountId}`);
    }
  }

  const sourceAccount = db.prepare(`
    SELECT id, institution, sourceAccountName, accountHolder
    FROM sourceAccounts
    WHERE id = ?
  `).get(sourceAccountId) as
    | { id: number; institution: string | null; sourceAccountName: string | null; accountHolder: string | null }
    | undefined;
  if (!sourceAccount) throw new Error(`Source account not found: ${sourceAccountId}`);

  db.prepare('UPDATE sourceAccounts SET accountId = ? WHERE id = ?').run(accountId, sourceAccountId);
  if (accountId !== null) {
    upsertAccountAlias(sourceAccount, accountId);
    applySourceAccountHolder(sourceAccount, accountId);
  }
}

function getSourceAccount(sourceAccountId: number) {
  const sourceAccount = getDb().prepare(`
    SELECT id, accountId, institution, sourceAccountName, accountHolder
    FROM sourceAccounts
    WHERE id = ?
  `).get(sourceAccountId) as
    | { id: number; accountId: number | null; institution: string | null; sourceAccountName: string | null; accountHolder: string | null }
    | undefined;
  if (!sourceAccount) throw new Error(`Source account not found: ${sourceAccountId}`);
  return sourceAccount;
}

function unarchiveAccountForImport(accountId: number) {
  const db = getDb();
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId) as { id: number } | undefined;
  if (!account) throw new Error(`Account not found: ${accountId}`);
  db.prepare(`
    UPDATE accounts
    SET status = 'active',
        archivedAt = NULL,
        updatedAt = @updatedAt
    WHERE id = @id
  `).run({ id: accountId, updatedAt: new Date().toISOString() });
}

function applyAccountMappingOverrides(accountMappings: AccountMappingDecision[] | null | undefined) {
  if (!accountMappings?.length) return;
  for (const mapping of accountMappings) {
    if (!Number.isFinite(Number(mapping.sourceAccountId))) continue;
    const sourceAccountId = Number(mapping.sourceAccountId);

    if (mapping.mode === 'auto') {
      const sourceAccount = getSourceAccount(sourceAccountId);
      const resolution = getImportAccountResolution(sourceAccount);
      if (!resolution.resolvedAccountId || resolution.resolvedAccountStatus === 'archived') {
        throw new Error('Import account mapping requires an explicit account choice.');
      }
      linkSourceAccount(sourceAccountId, resolution.resolvedAccountId);
      continue;
    }

    if (mapping.mode === 'create') {
      const sourceAccount = getSourceAccount(sourceAccountId);
      const accountId = createAccountForSourceMapping(mapping, sourceAccount);
      linkSourceAccount(sourceAccountId, accountId);
      continue;
    }

    if (mapping.mode === 'unarchive') {
      const accountId = Number(mapping.accountId);
      if (!Number.isFinite(accountId)) throw new Error('Account id is required to unarchive an import mapping.');
      unarchiveAccountForImport(accountId);
      linkSourceAccount(sourceAccountId, accountId);
      continue;
    }

    if (mapping.mode && mapping.mode !== 'existing') {
      throw new Error(`Unsupported account mapping mode: ${mapping.mode}`);
    }
    const accountId = mapping.accountId === null || mapping.accountId === undefined ? null : Number(mapping.accountId);
    if (accountId !== null && !Number.isFinite(accountId)) continue;
    linkSourceAccount(sourceAccountId, accountId);
  }
}

function getImportAccountResolution(sourceAccount: {
  id: number;
  accountId: number | null;
  institution: string | null;
  sourceAccountName: string | null;
  accountHolder?: string | null;
}): Pick<ImportAccountMapping, 'resolvedAccountId' | 'resolvedAccountStatus' | 'resolution'> {
  if (sourceAccount.accountId) {
    const linked = getDb().prepare('SELECT status FROM accounts WHERE id = ?').get(sourceAccount.accountId) as
      | { status: string | null }
      | undefined;
    const status = normalizeAccountStatus(linked?.status);
    return {
      resolvedAccountId: sourceAccount.accountId,
      resolvedAccountStatus: status,
      resolution: status === 'archived' ? 'archived-match' : 'linked',
    };
  }

  const alias = (sourceAccount.sourceAccountName || '').trim();
  const institution = (sourceAccount.institution || 'Unknown Institution').trim();
  if (!alias || alias === 'Selected account') {
    return { resolvedAccountId: null, resolvedAccountStatus: null, resolution: 'selected-fallback' };
  }

  const aliased = getDb().prepare(`
    SELECT aa.accountId, a.status
    FROM accountAliases aa
    JOIN accounts a ON a.id = aa.accountId
    WHERE aa.institution = ? AND aa.alias = ?
  `).get(institution, alias) as { accountId: number; status: string | null } | undefined;
  if (aliased) {
    const status = normalizeAccountStatus(aliased.status);
    return {
      resolvedAccountId: aliased.accountId,
      resolvedAccountStatus: status,
      resolution: status === 'archived' ? 'archived-match' : 'alias',
    };
  }

  const exact = getDb().prepare(`
    SELECT id, status
    FROM accounts
    WHERE institution IS ? AND name = ?
  `).get(institution, alias) as { id: number; status: string | null } | undefined;
  if (exact) {
    const status = normalizeAccountStatus(exact.status);
    return {
      resolvedAccountId: exact.id,
      resolvedAccountStatus: status,
      resolution: status === 'archived' ? 'archived-match' : 'exact',
    };
  }

  return { resolvedAccountId: null, resolvedAccountStatus: null, resolution: 'auto-create' };
}

function getImportAccountMappings(importFileId: number): ImportAccountMapping[] {
  const rows = getDb().prepare(`
    SELECT
      sa.id AS sourceAccountId,
      sa.accountId,
      sa.institution,
      sa.sourceAccountName,
      sa.accountHolder AS sourceAccountHolder,
      COUNT(DISTINCT st.id) AS transactionCount,
      COUNT(DISTINCT sb.id) AS balanceCount
    FROM sourceAccounts sa
    JOIN sourceFiles sf ON sf.id = sa.sourceFileId
    LEFT JOIN sourceTransactions st ON st.sourceAccountId = sa.id
    LEFT JOIN sourceBalances sb ON sb.sourceAccountId = sa.id
    WHERE sf.importFileId = ?
    GROUP BY sa.id
    ORDER BY sa.id ASC
  `).all(importFileId) as Array<{
    sourceAccountId: number;
    accountId: number | null;
    institution: string | null;
    sourceAccountName: string | null;
    sourceAccountHolder: string | null;
    transactionCount: number;
    balanceCount: number;
  }>;

  return rows.map(row => ({
    sourceAccountId: row.sourceAccountId,
    institution: row.institution,
    sourceAccountName: row.sourceAccountName,
    sourceAccountHolder: row.sourceAccountHolder,
    ...getImportAccountResolution({
      id: row.sourceAccountId,
      accountId: row.accountId,
      institution: row.institution,
      sourceAccountName: row.sourceAccountName,
      accountHolder: row.sourceAccountHolder,
    }),
    transactionCount: Number(row.transactionCount || 0),
    balanceCount: Number(row.balanceCount || 0),
  }));
}

function resolveImportedAccount(sourceAccountId: number | null | undefined, fallbackAccountId: number | null | undefined) {
  const db = getDb();
  if (!sourceAccountId) {
    if (!fallbackAccountId) throw new Error('accountId is required when parser does not identify an account');
    return fallbackAccountId;
  }

  const sourceAccount = db.prepare(`
    SELECT id, accountId, institution, sourceAccountName, accountHolder
    FROM sourceAccounts
    WHERE id = ?
  `).get(sourceAccountId) as
    | { id: number; accountId: number | null; institution: string | null; sourceAccountName: string | null; accountHolder: string | null }
    | undefined;

  if (!sourceAccount) {
    if (!fallbackAccountId) throw new Error(`Source account not found: ${sourceAccountId}`);
    return fallbackAccountId;
  }
  if (sourceAccount.accountId) {
    const account = db.prepare('SELECT status FROM accounts WHERE id = ?').get(sourceAccount.accountId) as
      | { status: string | null }
      | undefined;
    if (normalizeAccountStatus(account?.status) === 'archived') {
      throw new Error('Import account mapping matched an archived account. Choose unarchive, another account, or create a new account.');
    }
    return sourceAccount.accountId;
  }

  const alias = (sourceAccount.sourceAccountName || '').trim();
  const institution = (sourceAccount.institution || 'Unknown Institution').trim();
  if (!alias || alias === 'Selected account') {
    if (!fallbackAccountId) throw new Error('accountId is required when parser does not identify an account');
    db.prepare('UPDATE sourceAccounts SET accountId = ? WHERE id = ?').run(fallbackAccountId, sourceAccount.id);
    applySourceAccountHolder(sourceAccount, fallbackAccountId);
    return fallbackAccountId;
  }

  const aliased = db.prepare(`
    SELECT aa.accountId, a.status
    FROM accountAliases aa
    JOIN accounts a ON a.id = aa.accountId
    WHERE aa.institution = ? AND aa.alias = ?
  `).get(institution, alias) as { accountId: number; status: string | null } | undefined;
  if (aliased) {
    if (normalizeAccountStatus(aliased.status) === 'archived') {
      throw new Error('Import account mapping matched an archived account. Choose unarchive, another account, or create a new account.');
    }
    db.prepare('UPDATE sourceAccounts SET accountId = ? WHERE id = ?').run(aliased.accountId, sourceAccount.id);
    applySourceAccountHolder(sourceAccount, aliased.accountId);
    return aliased.accountId;
  }

  const exact = db.prepare(`
    SELECT id, status
    FROM accounts
    WHERE institution IS ? AND name = ?
  `).get(institution, alias) as { id: number; status: string | null } | undefined;
  if (exact && normalizeAccountStatus(exact.status) === 'archived') {
    throw new Error('Import account mapping matched an archived account. Choose unarchive, another account, or create a new account.');
  }
  const now = new Date().toISOString();
  const accountId = exact?.id ?? Number(insertRow('accounts', {
    name: alias,
    institution,
    type: inferAccountType(alias),
    currentBalance: 0,
    currency: 'USD',
    accountHolder: sourceAccount.accountHolder || null,
    status: 'active',
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }));

  upsertAccountAlias(sourceAccount, accountId);
  db.prepare('UPDATE sourceAccounts SET accountId = ? WHERE id = ?').run(accountId, sourceAccount.id);
  applySourceAccountHolder(sourceAccount, accountId);

  return accountId;
}

function parseCsv(text: string) {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  const fatalError = result.errors.find(error => error.type !== 'FieldMismatch');
  if (fatalError) throw new Error(fatalError.message);
  return result;
}

function isCsvFile(fileName: string) {
  return /\.(csv|txt)$/i.test(fileName);
}

async function withTempImportFile<T>(fileName: string, bytes: Uint8Array | undefined, fn: (filePath: string) => Promise<T>) {
  if (!bytes) return fn('');

  const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, '-');
  const filePath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'easymoney-import-')),
    safeName || 'import-file'
  );
  await fs.writeFile(filePath, bytes);

  try {
    return await fn(filePath);
  } finally {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  }
}

async function getParserSample(fileName: string, text: string, fileBytes?: Uint8Array) {
  if (!/\.pdf$/i.test(fileName) || !fileBytes) return text.slice(0, 4096);

  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(fileBytes));
    const extracted = await extractText(pdf);
    return extracted.text.join('\n').slice(0, 4096);
  } catch {
    return text.slice(0, 4096);
  }
}

function toPreviewTransaction(transaction: ParsedImportTransaction, importFileId: number, importRowId: number): ImportPreviewTransaction {
  const amount = dollarsFromCents(transaction.amountCents);
  const raw = transaction.raw || {};
  const merchant = typeof raw.merchant === 'string' ? raw.merchant : transaction.description;
  const originalDescription = typeof raw.originalDescription === 'string' ? raw.originalDescription : transaction.description;
  const originalCategory = typeof raw.originalCategory === 'string' && raw.originalCategory.trim()
    ? raw.originalCategory
    : typeof raw.category === 'string' && raw.category.trim()
      ? raw.category
      : null;
  const status = typeof raw.status === 'string' ? raw.status : 'cleared';
  const transactionKind = typeof raw.transactionKind === 'string'
    ? raw.transactionKind
    : null;

  return {
    ...transaction,
    importFileId,
    importRowId,
    amount,
    merchant,
    originalDescription,
    originalCategory,
    type: amount >= 0 ? 'credit' : 'debit',
    transactionKind,
    status,
    notes: '',
    categoryId: null,
  };
}

function saveImportPreview({
  fileName,
  text,
  headers,
  parserName,
  sourceType,
  parserPriority,
  institution,
  rawRows,
  parsedTransactions,
  parsedBalances = [],
}: {
  fileName: string;
  text: string;
  headers: string[];
  parserName: string | null;
  sourceType?: string | null;
  parserPriority?: number | null;
  institution?: string | null;
  rawRows: Array<Record<string, string>>;
  parsedTransactions: Array<ParsedImportTransaction | null>;
  parsedBalances?: ParsedImportBalance[];
}) {
  const now = new Date().toISOString();
  const headerSignature = getHeaderSignature(headers);
  const importFileId = insertRow('importFiles', {
    fileName,
    contentHash: hashContent(text),
    parserName,
    headerSignature,
    rowCount: rawRows.length,
    sourceType,
    parserPriority,
    institution,
    status: 'previewed',
    createdAt: now,
  });
  const sourceFileId = insertRow('sourceFiles', {
    importFileId,
    fileName,
    contentHash: hashContent(text),
    parserName,
    sourceType,
    parserPriority,
    institution,
    coveredFrom: [
      ...parsedTransactions.filter((item): item is ParsedImportTransaction => item !== null).map(item => item.date),
      ...parsedBalances.map(item => item.date),
    ].sort()[0] || null,
    coveredTo: [
      ...parsedTransactions.filter((item): item is ParsedImportTransaction => item !== null).map(item => item.date),
      ...parsedBalances.map(item => item.date),
    ].sort().at(-1) || null,
    status: 'previewed',
    createdAt: now,
  });
  const sourceAccountIds = new Map<string, number>();
  const getSourceAccountId = (item: Pick<ParsedImportTransaction | ParsedImportBalance, 'institution' | 'account' | 'accountHolder' | 'raw'>) => {
    const sourceInstitution = item.institution || institution || null;
    const sourceAccountName = item.account || 'Selected account';
    const sourceAccountHolder = item.accountHolder?.trim() || null;
    const sourceAccountKey = `${sourceInstitution || 'unknown'}|${sourceAccountHolder || ''}|${sourceAccountName}`;
    const existing = sourceAccountIds.get(sourceAccountKey);
    if (existing) return existing;

    const sourceAccountId = Number(insertRow('sourceAccounts', {
      sourceFileId,
      institution: sourceInstitution,
      sourceAccountKey,
      sourceAccountName,
      accountHolder: sourceAccountHolder,
      rawJson: JSON.stringify({ account: item.account, institution: item.institution, accountHolder: sourceAccountHolder }),
      createdAt: now,
    }));
    sourceAccountIds.set(sourceAccountKey, sourceAccountId);
    return sourceAccountId;
  };

  const rowIds: number[] = [];
  for (const [index, row] of rawRows.entries()) {
    const parsedTransaction = parsedTransactions[index];
    const importRowId = insertRow('importRows', {
      importFileId,
      rowIndex: index,
      rowType: 'transaction',
      rawJson: JSON.stringify(row),
      normalizedJson: parsedTransaction ? JSON.stringify(parsedTransaction) : null,
      createdAt: now,
    });
    rowIds[index] = Number(importRowId);

    if (parsedTransaction) {
      insertRow('sourceTransactions', {
        sourceFileId,
        sourceAccountId: getSourceAccountId(parsedTransaction),
        importRowId,
        stableSourceId: getStableSourceTransactionId(importFileId, parsedTransaction),
        date: parsedTransaction.date,
        amountCents: parsedTransaction.amountCents,
        description: parsedTransaction.description,
        sourceRole: parsedTransaction.sourceRole,
        priority: parserPriority,
        rawJson: JSON.stringify(parsedTransaction.raw || {}),
        createdAt: now,
      });
    }
  }

  const balanceRowIds: number[] = [];
  for (const [index, balance] of parsedBalances.entries()) {
    const importRowId = insertRow('importRows', {
      importFileId,
      rowIndex: rawRows.length + index,
      rowType: 'balance',
      rawJson: JSON.stringify(balance.raw || {}),
      normalizedJson: JSON.stringify(balance),
      createdAt: now,
    });
    balanceRowIds[index] = Number(importRowId);
    insertRow('sourceBalances', {
      sourceFileId,
      sourceAccountId: getSourceAccountId(balance),
      importRowId,
      date: balance.date,
      balanceCents: balance.balanceCents,
      priority: parserPriority,
      rawJson: JSON.stringify(balance.raw || {}),
      createdAt: now,
    });
  }

  return {
    importFileId: Number(importFileId),
    rowIds,
    balanceRowIds,
    accountMappings: getImportAccountMappings(Number(importFileId)),
  };
}

function toNumberSet(values: number[] | null | undefined) {
  if (values === null || values === undefined) return null;
  return new Set(values.map(value => Number(value)).filter(Number.isFinite));
}

function readStagedTransactions(importFileId: number, importRowIds: number[] | null | undefined) {
  const selectedIds = toNumberSet(importRowIds);
  const rows = getDb().prepare(`
    SELECT ir.id, ir.importFileId, ir.normalizedJson, st.sourceAccountId, sa.accountId AS resolvedAccountId
    FROM importRows ir
    LEFT JOIN sourceTransactions st ON st.importRowId = ir.id
    LEFT JOIN sourceAccounts sa ON sa.id = st.sourceAccountId
    WHERE ir.importFileId = @importFileId
      AND COALESCE(ir.rowType, 'transaction') = 'transaction'
      AND ir.normalizedJson IS NOT NULL
    ORDER BY ir.rowIndex ASC
  `).all({ importFileId }) as Array<{
    id: number;
    importFileId: number;
    normalizedJson: string;
    sourceAccountId: number | null;
    resolvedAccountId: number | null;
  }>;

  return rows
    .filter(row => !selectedIds || selectedIds.has(row.id))
    .map(row => ({
      ...toPreviewTransaction(
        JSON.parse(row.normalizedJson) as ParsedImportTransaction,
        row.importFileId,
        row.id
      ),
      sourceAccountId: row.sourceAccountId,
      resolvedAccountId: row.resolvedAccountId,
    }));
}

function readStagedBalances(importFileId: number, balanceRowIds: number[] | null | undefined) {
  const selectedIds = toNumberSet(balanceRowIds);
  const rows = getDb().prepare(`
    SELECT ir.id, ir.normalizedJson, sb.sourceAccountId, sa.accountId AS resolvedAccountId
    FROM importRows ir
    LEFT JOIN sourceBalances sb ON sb.importRowId = ir.id
    LEFT JOIN sourceAccounts sa ON sa.id = sb.sourceAccountId
    WHERE ir.importFileId = @importFileId
      AND ir.rowType = 'balance'
      AND ir.normalizedJson IS NOT NULL
    ORDER BY ir.rowIndex ASC
  `).all({ importFileId }) as Array<{
    id: number;
    normalizedJson: string;
    sourceAccountId: number | null;
    resolvedAccountId: number | null;
  }>;

  return rows
    .filter(row => !selectedIds || selectedIds.has(row.id))
    .map(row => ({
      importRowId: row.id,
      balance: JSON.parse(row.normalizedJson) as ParsedImportBalance,
      sourceAccountId: row.sourceAccountId,
      resolvedAccountId: row.resolvedAccountId,
    }));
}

export async function previewImport({ fileName, text, fileBytes, customProfile = null }: PreviewImportOptions) {
  let parsed: ReturnType<typeof parseCsv> | null = null;
  let csvParseError: Error | null = null;
  if (isCsvFile(fileName)) {
    try {
      parsed = parseCsv(text);
    } catch (error) {
      csvParseError = error as Error;
    }
  }
  const rows = parsed?.data || [];
  const headers = parsed?.meta.fields || Object.keys(rows[0] || {});
  if (parsed && !rows.length) throw new Error('No data found in CSV');

  const parserSample = await getParserSample(fileName, text, fileBytes);
  const appParser = customProfile
    ? {
        id: CUSTOM_CSV_PARSER_ID,
        name: customProfile.name || 'Custom CSV',
        institution: customProfile.name || 'Custom CSV',
        sourceType: 'activity-export' as const,
        priority: 0,
        parse: (input: Parameters<typeof parseCustomCsv>[0]) => parseCustomCsv(input, customProfile),
      }
    : resolveImportParser({ fileName, headers, sample: parserSample });

  if (appParser) {
    const parsedResult = await withTempImportFile(fileName, fileBytes, filePath => Promise.resolve(appParser.parse({
      fileName,
      headers,
      rows,
      text,
      filePath: filePath || undefined,
      fileBytes,
    })));
    const transactions = parsedResult.transactions.filter((transaction): transaction is ParsedImportTransaction => transaction !== null);
    if (!transactions.length && !parsedResult.balances.length) {
      throw new Error('Could not parse any valid transactions or balances from this file.');
    }
    const rawRows = rows.length
      ? rows
      : parsedResult.transactions.length
        ? parsedResult.transactions.map((transaction, index) => ({
          sourceRowIndex: String(transaction?.sourceRowIndex ?? index),
        }))
        : [];

    const preview = saveImportPreview({
      fileName,
      text,
      headers,
      parserName: appParser.id,
      sourceType: appParser.sourceType,
      parserPriority: appParser.priority,
      institution: appParser.institution,
      rawRows,
      parsedTransactions: parsedResult.transactions,
      parsedBalances: parsedResult.balances,
    });
    const previewTransactions = readStagedTransactions(
      preview.importFileId,
      transactions.map(transaction => preview.rowIds[transaction.sourceRowIndex])
    );

    return {
      importFileId: preview.importFileId,
      requiresMapping: false,
      profileUsed: appParser.name,
      profile: customProfile || null,
      headers,
      previewData: rows.slice(0, 5),
      mapping: mappingFromProfile(customProfile, headers),
      accountMappings: preview.accountMappings,
      balances: parsedResult.balances,
      balanceRowIds: preview.balanceRowIds,
      transactions: previewTransactions,
    };
  }

  if (csvParseError) throw csvParseError;
  if (!parsed || !rows.length) throw new Error('No parser matched this file.');

  const preview = saveImportPreview({
    fileName,
    text,
    headers,
    parserName: null,
    sourceType: null,
    parserPriority: null,
    institution: null,
    rawRows: rows,
    parsedTransactions: rows.map(() => null),
  });

  return {
    importFileId: preview.importFileId,
    requiresMapping: true,
    headers,
    previewData: rows.slice(0, 5),
    mapping: mappingFromProfile(null, headers),
    accountMappings: preview.accountMappings,
    balances: [],
  };
}

export function materializeImportTransactions({
  accountId,
  importFileId: stagedImportFileId = null,
  importRowIds = null,
  forceImportRowIds = null,
  balanceRowIds = null,
  transactions = [],
  accountMappings = null,
  fallbackImportFileId = null,
}: MaterializeImportTransactionsOptions) {
  if (!Array.isArray(transactions)) throw new Error('transactions must be an array');
  if (importRowIds !== null && !Array.isArray(importRowIds)) throw new Error('importRowIds must be an array');
  if (forceImportRowIds !== null && !Array.isArray(forceImportRowIds)) throw new Error('forceImportRowIds must be an array');
  if (balanceRowIds !== null && !Array.isArray(balanceRowIds)) throw new Error('balanceRowIds must be an array');
  const forcedImportRowIds = toNumberSet(forceImportRowIds) || new Set<number>();

  applyAccountMappingOverrides(accountMappings);

  const stagedTransactions = stagedImportFileId
    ? readStagedTransactions(stagedImportFileId, importRowIds)
    : [];
  const stagedBalances = stagedImportFileId
    ? readStagedBalances(stagedImportFileId, balanceRowIds)
    : [];
  const transactionsToCommit = stagedImportFileId ? stagedTransactions : transactions;

  const db = getDb();
  const accountById = new Map<number, { id: number; type?: string | null; currentBalance?: number | null; status?: string | null }>();
  const getAccount = (id: number) => {
    const existing = accountById.get(id);
    if (existing) return existing;
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | { id: number; type?: string | null; currentBalance?: number | null; status?: string | null }
      | undefined;
    if (!account) throw new Error(`Account not found: ${id}`);
    if (normalizeAccountStatus(account.status) === 'archived') {
      throw new Error(`Account is archived: ${id}`);
    }
    accountById.set(id, account);
    return account;
  };

  const seenByAccountId = new Map<number, Set<string>>();
  const getSeen = (resolvedAccountId: number) => {
    const existing = seenByAccountId.get(resolvedAccountId);
    if (existing) return existing;
    const accountTransactions = db.prepare('SELECT * FROM transactions WHERE accountId = ?').all(resolvedAccountId) as ImportTransactionInput[];
    const seen = new Set(accountTransactions.map(transaction =>
      transaction.fingerprint || getTransactionFingerprint(transaction, resolvedAccountId)
    ));
    seenByAccountId.set(resolvedAccountId, seen);
    return seen;
  };

  const unique: CommitImportTransaction[] = [];
  const duplicates: Array<ImportTransactionInput & { fingerprint: string }> = [];

  for (const transaction of transactionsToCommit.filter(item => item && item.date && typeof item.amount === 'number')) {
    const resolvedAccountId = transaction.resolvedAccountId || resolveImportedAccount(transaction.sourceAccountId, accountId);
    const account = getAccount(resolvedAccountId);
    const seen = getSeen(resolvedAccountId);
    const fingerprint = getTransactionFingerprint(transaction, resolvedAccountId);
    const withFingerprint = { ...transaction, fingerprint };
    const forceImport = Boolean(transaction.importRowId && forcedImportRowIds.has(transaction.importRowId));
    if (seen.has(fingerprint) && !forceImport) {
      duplicates.push(withFingerprint);
      continue;
    }

    unique.push({
      ...withFingerprint,
      importFileId: transaction.importFileId || fallbackImportFileId || 0,
      importRowId: transaction.importRowId || 0,
      sourceRowIndex: transaction.sourceRowIndex || 0,
      amountCents: transaction.amountCents ?? Math.round(transaction.amount * 100),
      sourceRole: transaction.sourceRole || 'activity',
      description: transaction.description || '',
      merchant: transaction.merchant || transaction.description || '',
      originalDescription: transaction.originalDescription || transaction.description || transaction.merchant || '',
      originalCategory: transaction.originalCategory || null,
      categoryId: null,
      type: transaction.type || (transaction.amount >= 0 ? 'credit' : 'debit'),
      status: transaction.status || 'cleared',
      notes: transaction.notes || '',
      accountId: resolvedAccountId,
      importBatchId: '',
      transactionKind: isCreditAccount(account) && transaction.amount > 0
        ? 'card_payment'
        : transaction.transactionKind || null,
    });
  }

  const importBatchId = [
    'import',
    accountId || unique[0]?.accountId || 'resolved',
    unique[0]?.date || transactionsToCommit[0]?.date || 'unknown-start',
    unique.at(-1)?.date || transactionsToCommit.at(-1)?.date || 'unknown-end',
    transactionsToCommit.length,
  ].join('-');
  const now = new Date().toISOString();
  const latestBalance = stagedBalances
    .sort((a, b) => a.balance.date.localeCompare(b.balance.date))
    .at(-1);
  const importFileId = stagedImportFileId || fallbackImportFileId || transactionsToCommit.find(transaction => transaction.importFileId)?.importFileId || null;
  const uniqueBaseKeys = new Set(unique.map(transaction => getLedgerTransactionBaseKey(transaction)));
  const existingLedgerTransactions = unique.length
    ? db.prepare(`
        SELECT *
        FROM ledgerTransactions
        WHERE accountId IN (${[...new Set(unique.map(transaction => transaction.accountId))].map(() => '?').join(',')})
      `).all([...new Set(unique.map(transaction => transaction.accountId))]) as ImportTransactionInput[]
    : [];
  const existingLedgerPlaceholders = existingLedgerTransactions
    .map(transaction => ({
      ...transaction,
      amount: dollarsFromCents(Number(transaction.amountCents || 0)),
    }))
    .filter(transaction => uniqueBaseKeys.has(getLedgerTransactionBaseKey(transaction)));
  const assignedTransactions = assignLedgerTransactionIdentities([
    ...existingLedgerPlaceholders,
    ...unique,
  ]);
  const transactionsWithLedgerIds = assignedTransactions
    .filter(({ transaction }) => unique.includes(transaction as CommitImportTransaction))
    .map(({ transaction, occurrenceIndex, ledgerTransactionId }) => ({
      transaction: transaction as CommitImportTransaction,
      occurrenceIndex,
      ledgerTransactionId,
    }));

  db.transaction(() => {
    for (const { transaction, occurrenceIndex, ledgerTransactionId } of transactionsWithLedgerIds) {
      const transactionId = insertRow('transactions', {
        ...transaction,
        ledgerTransactionId,
        occurrenceIndex,
        importBatchId: getMaterializedImportBatchId(transaction.fingerprint),
        createdAt: now,
      });

      if (transaction.importRowId) {
        db.prepare(`
          UPDATE importRows
          SET fingerprint = @fingerprint, transactionId = @transactionId
          WHERE id = @importRowId
            AND importFileId = @importFileId
        `).run({
          fingerprint: transaction.fingerprint,
          transactionId,
          importFileId,
          importRowId: transaction.importRowId,
        });
      }

      db.prepare(`
        INSERT INTO ledgerTransactions (
          ledgerTransactionId,
          legacyTransactionId,
          accountId,
          date,
          amountCents,
          importBatchId,
          description,
          merchant,
          originalDescription,
          originalCategory,
          type,
          transactionKind,
          status,
          fingerprint,
          sourceRole,
          occurrenceIndex,
          importFileId,
          importRowId,
          sourceTransactionId,
          createdAt,
          updatedAt
        )
        VALUES (
          @ledgerTransactionId,
          @legacyTransactionId,
          @accountId,
          @date,
          @amountCents,
          @importBatchId,
          @description,
          @merchant,
          @originalDescription,
          @originalCategory,
          @type,
          @transactionKind,
          @status,
          @fingerprint,
          @sourceRole,
          @occurrenceIndex,
          @importFileId,
          @importRowId,
          (
            SELECT id
            FROM sourceTransactions
            WHERE importRowId = @importRowId
            LIMIT 1
          ),
          @createdAt,
          @updatedAt
        )
        ON CONFLICT(ledgerTransactionId) DO UPDATE SET
          legacyTransactionId = excluded.legacyTransactionId,
          accountId = excluded.accountId,
          date = excluded.date,
          amountCents = excluded.amountCents,
          importBatchId = excluded.importBatchId,
          description = excluded.description,
          merchant = excluded.merchant,
          originalDescription = excluded.originalDescription,
          originalCategory = excluded.originalCategory,
          type = excluded.type,
          transactionKind = excluded.transactionKind,
          status = excluded.status,
          fingerprint = excluded.fingerprint,
          sourceRole = excluded.sourceRole,
          occurrenceIndex = excluded.occurrenceIndex,
          importFileId = excluded.importFileId,
          importRowId = excluded.importRowId,
          sourceTransactionId = excluded.sourceTransactionId,
          updatedAt = excluded.updatedAt
      `).run({
        ledgerTransactionId,
        legacyTransactionId: transactionId,
        accountId: transaction.accountId,
        date: transaction.date,
        amountCents: transaction.amountCents,
        importBatchId: getMaterializedImportBatchId(transaction.fingerprint),
        description: transaction.description,
        merchant: transaction.merchant,
        originalDescription: transaction.originalDescription,
        originalCategory: transaction.originalCategory,
        type: transaction.type,
        transactionKind: transaction.transactionKind,
        status: transaction.status,
        fingerprint: transaction.fingerprint,
        sourceRole: transaction.sourceRole,
        occurrenceIndex,
        importFileId: transaction.importFileId || importFileId,
        importRowId: transaction.importRowId || null,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (unique.length) {
      const totalsByAccountId = new Map<number, number>();
      for (const transaction of unique) {
        totalsByAccountId.set(transaction.accountId, (totalsByAccountId.get(transaction.accountId) || 0) + transaction.amount);
      }
      for (const [resolvedAccountId, amount] of totalsByAccountId) {
        const account = getAccount(resolvedAccountId);
        updateRow('accounts', resolvedAccountId, {
          currentBalance: Number(account.currentBalance || 0) + amount,
          updatedAt: now,
        });
      }
    }

    for (const { importRowId, balance, sourceAccountId, resolvedAccountId } of stagedBalances) {
      const balanceAccountId = resolvedAccountId || resolveImportedAccount(sourceAccountId, accountId);
      getAccount(balanceAccountId);
      db.prepare(`
        UPDATE sourceAccounts
        SET accountId = @accountId
        WHERE id = @sourceAccountId
      `).run({
        accountId: balanceAccountId,
        sourceAccountId,
      });

      db.prepare(`
        INSERT INTO balanceSnapshots (accountId, month, balance, capturedAt)
        VALUES (@accountId, @month, @balance, @capturedAt)
        ON CONFLICT(accountId, month) DO UPDATE SET
          balance = excluded.balance,
          capturedAt = excluded.capturedAt
      `).run({
        accountId: balanceAccountId,
        month: balance.date.slice(0, 7),
        balance: dollarsFromCents(balance.balanceCents),
        capturedAt: `${balance.date.slice(0, 10)}T00:00:00.000Z`,
      });

      db.prepare(`
        INSERT INTO ledgerBalances (
          accountId,
          month,
          balanceCents,
          capturedAt,
          sourceBalanceId,
          createdAt,
          updatedAt
        )
        VALUES (
          @accountId,
          @month,
          @balanceCents,
          @capturedAt,
          (
            SELECT id
            FROM sourceBalances
            WHERE importRowId = @importRowId
            LIMIT 1
          ),
          @createdAt,
          @updatedAt
        )
        ON CONFLICT(accountId, month) DO UPDATE SET
          balanceCents = excluded.balanceCents,
          capturedAt = excluded.capturedAt,
          sourceBalanceId = excluded.sourceBalanceId,
          updatedAt = excluded.updatedAt
      `).run({
        accountId: balanceAccountId,
        month: balance.date.slice(0, 7),
        balanceCents: balance.balanceCents,
        capturedAt: `${balance.date.slice(0, 10)}T00:00:00.000Z`,
        importRowId,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (latestBalance) {
      const latestBalanceAccountId = resolveImportedAccount(latestBalance.sourceAccountId, accountId);
      updateRow('accounts', latestBalanceAccountId, {
        currentBalance: dollarsFromCents(latestBalance.balance.balanceCents),
        updatedAt: now,
      });
    }

    if (importFileId) {
      updateRow('importFiles', importFileId, {
        status: 'committed',
        importBatchId,
        committedAt: now,
      });
      getDb().prepare(`
        UPDATE sourceFiles
        SET status = 'committed', committedAt = @committedAt
        WHERE importFileId = @importFileId
      `).run({
        importFileId,
        committedAt: now,
      });
    }
  })();

  return {
    importedCount: unique.length,
    skippedDuplicateCount: duplicates.length,
    importedBalanceCount: stagedBalances.length,
    importBatchId,
    insertedFingerprints: unique.map(transaction => transaction.fingerprint),
  };
}

export function commitImport({
  accountId,
  importFileId = null,
  importRowIds = null,
  forceImportRowIds = null,
  balanceRowIds = null,
  transactions = [],
  accountMappings = null,
  importMeta = null,
  rebuildLedger = true,
}: CommitImportOptions) {
  const result = materializeImportTransactions({
    accountId,
    importFileId,
    importRowIds,
    forceImportRowIds,
    balanceRowIds,
    transactions,
    accountMappings: accountMappings || importMeta?.accountMappings || null,
    fallbackImportFileId: importMeta?.importFileId || null,
  });

  if (importMeta?.headers?.length && importMeta.profile) {
    const db = getDb();
    const now = new Date().toISOString();
    const headerSignature = getHeaderSignature(importMeta.headers);
    const existingProfile = db.prepare('SELECT id FROM importProfiles WHERE headerSignature = ?').get(headerSignature) as
      | { id: number }
      | undefined;
    const row = {
      headerSignature,
      profileName: importMeta.profileName || importMeta.profile.name,
      profileJson: JSON.stringify(importMeta.profile),
      mappingJson: JSON.stringify(importMeta.mapping || mappingFromProfile(importMeta.profile, importMeta.headers)),
      lastAccountId: accountId,
      updatedAt: now,
    };

    if (existingProfile) {
      updateRow('importProfiles', existingProfile.id, row);
    } else {
      insertRow('importProfiles', {
        ...row,
        createdAt: now,
      });
    }
  }

  if (rebuildLedger && importFileHasSourceFacts(importFileId) && !(forceImportRowIds?.length)) {
    rebuildLedgerReadModel();
  }

  return result;
}

export function rebuildLedgerReadModel() {
  const db = getDb();
  return materializeLedger(db, buildLedgerFromSourceFacts(db));
}
