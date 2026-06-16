import Papa from 'papaparse';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDb, hashContent, insertRow, updateRow } from '../database.js';
import type { CommitImportTransaction, ImportAccountMapping, ImportPreviewTransaction, ImportProfile, ParsedImportBalance, ParsedImportTransaction } from './importTypes.ts';
import { CUSTOM_CSV_PARSER_ID, parseCustomCsv } from './importParsers/customCsv.ts';
import { mappingFromProfile } from './importParsers/csvMapping.ts';
import { resolveImportParser } from './importParsers/index.ts';
import { buildLedgerFromSourceFacts, materializeLedger } from './ledgerRebuild.ts';
import { assignLedgerTransactionIdentities } from './transactionIdentity.ts';

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

interface CommitImportOptions {
  accountId?: number | null;
  importFileId?: number | null;
  importRowIds?: number[] | null;
  balanceRowIds?: number[] | null;
  transactions?: ImportTransactionInput[];
  accountMappings?: Array<{ sourceAccountId: number; accountId: number | null }> | null;
  importMeta?: {
    importFileId?: number | null;
    headers?: string[];
    profile?: ImportProfile | null;
    mapping?: Record<string, unknown> | null;
    profileName?: string | null;
    accountMappings?: Array<{ sourceAccountId: number; accountId: number | null }> | null;
  } | null;
}

interface MaterializeImportTransactionsOptions {
  accountId?: number | null;
  importFileId?: number | null;
  importRowIds?: number[] | null;
  balanceRowIds?: number[] | null;
  transactions?: ImportTransactionInput[];
  accountMappings?: Array<{ sourceAccountId: number; accountId: number | null }> | null;
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
  if (/\b(ira|roth|brokerage|investment|merrill|vanguard|retirement|annuity)\b/.test(normalized)) return 'investment';
  if (/\b(checking|chk)\b/.test(normalized)) return 'checking';
  return 'other';
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

function linkSourceAccount(sourceAccountId: number, accountId: number | null) {
  const db = getDb();
  if (accountId !== null) {
    const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId) as { id: number } | undefined;
    if (!account) throw new Error(`Account not found: ${accountId}`);
  }

  const sourceAccount = db.prepare(`
    SELECT id, institution, sourceAccountName
    FROM sourceAccounts
    WHERE id = ?
  `).get(sourceAccountId) as
    | { id: number; institution: string | null; sourceAccountName: string | null }
    | undefined;
  if (!sourceAccount) throw new Error(`Source account not found: ${sourceAccountId}`);

  db.prepare('UPDATE sourceAccounts SET accountId = ? WHERE id = ?').run(accountId, sourceAccountId);
  if (accountId !== null) upsertAccountAlias(sourceAccount, accountId);
}

function applyAccountMappingOverrides(accountMappings: Array<{ sourceAccountId: number; accountId: number | null }> | null | undefined) {
  if (!accountMappings?.length) return;
  for (const mapping of accountMappings) {
    if (!Number.isFinite(Number(mapping.sourceAccountId))) continue;
    const accountId = mapping.accountId === null || mapping.accountId === undefined ? null : Number(mapping.accountId);
    if (accountId !== null && !Number.isFinite(accountId)) continue;
    linkSourceAccount(Number(mapping.sourceAccountId), accountId);
  }
}

function getImportAccountResolution(sourceAccount: {
  id: number;
  accountId: number | null;
  institution: string | null;
  sourceAccountName: string | null;
}): Pick<ImportAccountMapping, 'resolvedAccountId' | 'resolution'> {
  if (sourceAccount.accountId) {
    return { resolvedAccountId: sourceAccount.accountId, resolution: 'linked' };
  }

  const alias = (sourceAccount.sourceAccountName || '').trim();
  const institution = (sourceAccount.institution || 'Unknown Institution').trim();
  if (!alias || alias === 'Selected account') {
    return { resolvedAccountId: null, resolution: 'selected-fallback' };
  }

  const aliased = getDb().prepare(`
    SELECT accountId
    FROM accountAliases
    WHERE institution = ? AND alias = ?
  `).get(institution, alias) as { accountId: number } | undefined;
  if (aliased) return { resolvedAccountId: aliased.accountId, resolution: 'alias' };

  const exact = getDb().prepare(`
    SELECT id
    FROM accounts
    WHERE institution IS ? AND name = ?
  `).get(institution, alias) as { id: number } | undefined;
  if (exact) return { resolvedAccountId: exact.id, resolution: 'exact' };

  return { resolvedAccountId: null, resolution: 'auto-create' };
}

function getImportAccountMappings(importFileId: number): ImportAccountMapping[] {
  const rows = getDb().prepare(`
    SELECT
      sa.id AS sourceAccountId,
      sa.accountId,
      sa.institution,
      sa.sourceAccountName,
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
    transactionCount: number;
    balanceCount: number;
  }>;

  return rows.map(row => ({
    sourceAccountId: row.sourceAccountId,
    institution: row.institution,
    sourceAccountName: row.sourceAccountName,
    ...getImportAccountResolution({
      id: row.sourceAccountId,
      accountId: row.accountId,
      institution: row.institution,
      sourceAccountName: row.sourceAccountName,
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
    SELECT id, accountId, institution, sourceAccountName
    FROM sourceAccounts
    WHERE id = ?
  `).get(sourceAccountId) as
    | { id: number; accountId: number | null; institution: string | null; sourceAccountName: string | null }
    | undefined;

  if (!sourceAccount) {
    if (!fallbackAccountId) throw new Error(`Source account not found: ${sourceAccountId}`);
    return fallbackAccountId;
  }
  if (sourceAccount.accountId) return sourceAccount.accountId;

  const alias = (sourceAccount.sourceAccountName || '').trim();
  const institution = (sourceAccount.institution || 'Unknown Institution').trim();
  if (!alias || alias === 'Selected account') {
    if (!fallbackAccountId) throw new Error('accountId is required when parser does not identify an account');
    db.prepare('UPDATE sourceAccounts SET accountId = ? WHERE id = ?').run(fallbackAccountId, sourceAccount.id);
    return fallbackAccountId;
  }

  const aliased = db.prepare(`
    SELECT accountId
    FROM accountAliases
    WHERE institution = ? AND alias = ?
  `).get(institution, alias) as { accountId: number } | undefined;
  if (aliased) {
    db.prepare('UPDATE sourceAccounts SET accountId = ? WHERE id = ?').run(aliased.accountId, sourceAccount.id);
    return aliased.accountId;
  }

  const exact = db.prepare(`
    SELECT id
    FROM accounts
    WHERE institution IS ? AND name = ?
  `).get(institution, alias) as { id: number } | undefined;
  const now = new Date().toISOString();
  const accountId = exact?.id ?? Number(insertRow('accounts', {
    name: alias,
    institution,
    type: inferAccountType(alias),
    currentBalance: 0,
    currency: 'USD',
    createdAt: now,
    updatedAt: now,
  }));

  upsertAccountAlias(sourceAccount, accountId);
  db.prepare('UPDATE sourceAccounts SET accountId = ? WHERE id = ?').run(accountId, sourceAccount.id);

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
  const getSourceAccountId = (item: Pick<ParsedImportTransaction | ParsedImportBalance, 'institution' | 'account' | 'raw'>) => {
    const sourceInstitution = item.institution || institution || null;
    const sourceAccountName = item.account || 'Selected account';
    const sourceAccountKey = `${sourceInstitution || 'unknown'}|${sourceAccountName}`;
    const existing = sourceAccountIds.get(sourceAccountKey);
    if (existing) return existing;

    const sourceAccountId = Number(insertRow('sourceAccounts', {
      sourceFileId,
      institution: sourceInstitution,
      sourceAccountKey,
      sourceAccountName,
      rawJson: JSON.stringify({ account: item.account, institution: item.institution }),
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

  const appParser = customProfile
    ? {
        id: CUSTOM_CSV_PARSER_ID,
        name: customProfile.name || 'Custom CSV',
        institution: customProfile.name || 'Custom CSV',
        sourceType: 'activity-export' as const,
        priority: 0,
        parse: (input: Parameters<typeof parseCustomCsv>[0]) => parseCustomCsv(input, customProfile),
      }
    : resolveImportParser({ fileName, headers, sample: text.slice(0, 4096) });

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
  balanceRowIds = null,
  transactions = [],
  accountMappings = null,
  fallbackImportFileId = null,
}: MaterializeImportTransactionsOptions) {
  if (!Array.isArray(transactions)) throw new Error('transactions must be an array');
  if (importRowIds !== null && !Array.isArray(importRowIds)) throw new Error('importRowIds must be an array');
  if (balanceRowIds !== null && !Array.isArray(balanceRowIds)) throw new Error('balanceRowIds must be an array');

  applyAccountMappingOverrides(accountMappings);

  const stagedTransactions = stagedImportFileId
    ? readStagedTransactions(stagedImportFileId, importRowIds)
    : [];
  const stagedBalances = stagedImportFileId
    ? readStagedBalances(stagedImportFileId, balanceRowIds)
    : [];
  const transactionsToCommit = stagedImportFileId ? stagedTransactions : transactions;

  const db = getDb();
  const accountById = new Map<number, { id: number; type?: string | null; currentBalance?: number | null }>();
  const getAccount = (id: number) => {
    const existing = accountById.get(id);
    if (existing) return existing;
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | { id: number; type?: string | null; currentBalance?: number | null }
      | undefined;
    if (!account) throw new Error(`Account not found: ${id}`);
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
    if (seen.has(fingerprint)) {
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
  const transactionsWithLedgerIds = assignLedgerTransactionIdentities(unique);

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
  balanceRowIds = null,
  transactions = [],
  accountMappings = null,
  importMeta = null,
}: CommitImportOptions) {
  const result = materializeImportTransactions({
    accountId,
    importFileId,
    importRowIds,
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

  if (importFileHasSourceFacts(importFileId)) {
    materializeLedger(getDb(), buildLedgerFromSourceFacts(getDb()));
  }

  return result;
}
