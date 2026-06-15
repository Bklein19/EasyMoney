import Papa from 'papaparse';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDb, hashContent, insertRow, updateRow } from '../database.js';
import type { CommitImportTransaction, ImportPreviewTransaction, ImportProfile, ParsedImportBalance, ParsedImportTransaction } from './importTypes.ts';
import { CUSTOM_CSV_PARSER_ID, parseCustomCsv } from './importParsers/customCsv.ts';
import { mappingFromProfile } from './importParsers/csvMapping.ts';
import { resolveImportParser } from './importParsers/index.ts';
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
  accountId: number;
  importFileId?: number | null;
  importRowIds?: number[] | null;
  balanceRowIds?: number[] | null;
  transactions?: ImportTransactionInput[];
  importMeta?: {
    importFileId?: number | null;
    headers?: string[];
    profile?: ImportProfile | null;
    mapping?: Record<string, unknown> | null;
    profileName?: string | null;
  } | null;
}

interface MaterializeImportTransactionsOptions {
  accountId: number;
  importFileId?: number | null;
  importRowIds?: number[] | null;
  balanceRowIds?: number[] | null;
  transactions?: ImportTransactionInput[];
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

  return { importFileId: Number(importFileId), rowIds, balanceRowIds };
}

function toNumberSet(values: number[] | null | undefined) {
  if (values === null || values === undefined) return null;
  return new Set(values.map(value => Number(value)).filter(Number.isFinite));
}

function readStagedTransactions(importFileId: number, importRowIds: number[] | null | undefined) {
  const selectedIds = toNumberSet(importRowIds);
  const rows = getDb().prepare(`
    SELECT id, importFileId, normalizedJson
    FROM importRows
    WHERE importFileId = @importFileId
      AND COALESCE(rowType, 'transaction') = 'transaction'
      AND normalizedJson IS NOT NULL
    ORDER BY rowIndex ASC
  `).all({ importFileId }) as Array<{
    id: number;
    importFileId: number;
    normalizedJson: string;
  }>;

  return rows
    .filter(row => !selectedIds || selectedIds.has(row.id))
    .map(row => toPreviewTransaction(
      JSON.parse(row.normalizedJson) as ParsedImportTransaction,
      row.importFileId,
      row.id
    ));
}

function readStagedBalances(importFileId: number, balanceRowIds: number[] | null | undefined) {
  const selectedIds = toNumberSet(balanceRowIds);
  const rows = getDb().prepare(`
    SELECT id, normalizedJson
    FROM importRows
    WHERE importFileId = @importFileId
      AND rowType = 'balance'
      AND normalizedJson IS NOT NULL
    ORDER BY rowIndex ASC
  `).all({ importFileId }) as Array<{
    id: number;
    normalizedJson: string;
  }>;

  return rows
    .filter(row => !selectedIds || selectedIds.has(row.id))
    .map(row => ({
      importRowId: row.id,
      balance: JSON.parse(row.normalizedJson) as ParsedImportBalance,
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
    const previewTransactions = transactions.map(transaction =>
      toPreviewTransaction(transaction, preview.importFileId, preview.rowIds[transaction.sourceRowIndex])
    );

    return {
      importFileId: preview.importFileId,
      requiresMapping: false,
      profileUsed: appParser.name,
      profile: customProfile || null,
      headers,
      previewData: rows.slice(0, 5),
      mapping: mappingFromProfile(customProfile, headers),
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
    balances: [],
  };
}

export function materializeImportTransactions({
  accountId,
  importFileId: stagedImportFileId = null,
  importRowIds = null,
  balanceRowIds = null,
  transactions = [],
  fallbackImportFileId = null,
}: MaterializeImportTransactionsOptions) {
  if (!accountId) throw new Error('accountId is required');
  if (!Array.isArray(transactions)) throw new Error('transactions must be an array');
  if (importRowIds !== null && !Array.isArray(importRowIds)) throw new Error('importRowIds must be an array');
  if (balanceRowIds !== null && !Array.isArray(balanceRowIds)) throw new Error('balanceRowIds must be an array');

  const stagedTransactions = stagedImportFileId
    ? readStagedTransactions(stagedImportFileId, importRowIds)
    : [];
  const stagedBalances = stagedImportFileId
    ? readStagedBalances(stagedImportFileId, balanceRowIds)
    : [];
  const transactionsToCommit = stagedImportFileId ? stagedTransactions : transactions;

  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as
    | { id: number; type?: string | null; currentBalance?: number | null }
    | undefined;
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const existing = db.prepare('SELECT * FROM transactions WHERE accountId = ?').all(accountId) as ImportTransactionInput[];
  const seen = new Set(existing.map(transaction =>
    transaction.fingerprint || getTransactionFingerprint(transaction, accountId)
  ));

  const unique: CommitImportTransaction[] = [];
  const duplicates: Array<ImportTransactionInput & { fingerprint: string }> = [];

  for (const transaction of transactionsToCommit.filter(item => item && item.date && typeof item.amount === 'number')) {
    const fingerprint = getTransactionFingerprint(transaction, accountId);
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
      accountId,
      importBatchId: '',
      transactionKind: isCreditAccount(account) && transaction.amount > 0
        ? 'card_payment'
        : transaction.transactionKind || null,
    });
  }

  const importBatchId = [
    'import',
    accountId,
    unique[0]?.date || transactionsToCommit[0]?.date || 'unknown-start',
    unique.at(-1)?.date || transactionsToCommit.at(-1)?.date || 'unknown-end',
    transactionsToCommit.length,
  ].join('-');
  const now = new Date().toISOString();
  const totalAmount = unique.reduce((sum, transaction) => sum + transaction.amount, 0);
  const latestBalance = stagedBalances
    .map(item => item.balance)
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1);
  const importFileId = stagedImportFileId || fallbackImportFileId || transactionsToCommit.find(transaction => transaction.importFileId)?.importFileId || null;
  const transactionsWithLedgerIds = assignLedgerTransactionIdentities(unique);

  db.transaction(() => {
    if (importFileId) {
      getDb().prepare(`
        UPDATE sourceAccounts
        SET accountId = @accountId
        WHERE sourceFileId IN (
          SELECT id FROM sourceFiles WHERE importFileId = @importFileId
        )
      `).run({
        accountId,
        importFileId,
      });
    }

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
    }

    if (unique.length) {
      updateRow('accounts', accountId, {
        currentBalance: Number(account.currentBalance || 0) + totalAmount,
        updatedAt: now,
      });
    }

    for (const { balance } of stagedBalances) {
      db.prepare(`
        INSERT INTO balanceSnapshots (accountId, month, balance, capturedAt)
        VALUES (@accountId, @month, @balance, @capturedAt)
        ON CONFLICT(accountId, month) DO UPDATE SET
          balance = excluded.balance,
          capturedAt = excluded.capturedAt
      `).run({
        accountId,
        month: balance.date.slice(0, 7),
        balance: dollarsFromCents(balance.balanceCents),
        capturedAt: `${balance.date.slice(0, 10)}T00:00:00.000Z`,
      });
    }

    if (latestBalance) {
      updateRow('accounts', accountId, {
        currentBalance: dollarsFromCents(latestBalance.balanceCents),
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
  importMeta = null,
}: CommitImportOptions) {
  const result = materializeImportTransactions({
    accountId,
    importFileId,
    importRowIds,
    balanceRowIds,
    transactions,
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

  return result;
}
