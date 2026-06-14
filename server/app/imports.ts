import Papa from 'papaparse';
import { getDb, hashContent, insertRow, updateRow } from '../database.js';
import {
  detectBank,
  enhanceProfileWithHeaders,
  mappingFromProfile,
  normalizeTransaction,
} from '../../src/utils/bankProfiles.js';
import type { CommitImportTransaction, ImportPreviewTransaction, ImportProfile, ParsedImportTransaction } from './importTypes.ts';
import { resolveImportParser } from './importParsers/index.ts';

interface PreviewImportOptions {
  fileName: string;
  text: string;
  customProfile?: ImportProfile | null;
}

type ImportTransactionInput = Partial<ImportPreviewTransaction> & {
  date: string;
  amount: number;
};

interface LegacyNormalizedTransaction {
  date: string;
  amount: number;
  description?: string | null;
  merchant?: string | null;
  originalDescription?: string | null;
  originalCategory?: string | null;
  type?: string | null;
  transactionKind?: string | null;
  status?: string | null;
  notes?: string | null;
}

interface CommitImportOptions {
  accountId: number;
  importFileId?: number | null;
  importRowIds?: number[] | null;
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

function toParsedImportTransaction(transaction: LegacyNormalizedTransaction | null, sourceRowIndex: number): ParsedImportTransaction | null {
  if (!transaction) return null;

  return {
    sourceRowIndex,
    date: transaction.date,
    amountCents: Math.round(transaction.amount * 100),
    description: transaction.description || '',
    institution: null,
    account: null,
    sourceRole: 'activity',
    raw: {
      merchant: transaction.merchant || transaction.description || '',
      originalDescription: transaction.originalDescription || transaction.description || '',
      originalCategory: transaction.originalCategory || null,
      status: transaction.status || 'cleared',
      transactionKind: transaction.transactionKind || null,
    },
  };
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
    : amount > 0 ? 'card_payment' : null;

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

  const rowIds: number[] = [];
  for (const [index, row] of rawRows.entries()) {
    const importRowId = insertRow('importRows', {
      importFileId,
      rowIndex: index,
      rawJson: JSON.stringify(row),
      normalizedJson: parsedTransactions[index] ? JSON.stringify(parsedTransactions[index]) : null,
      createdAt: now,
    });
    rowIds[index] = Number(importRowId);
  }

  return { importFileId: Number(importFileId), rowIds };
}

function toNumberSet(values: number[] | null | undefined) {
  if (!values?.length) return null;
  return new Set(values.map(value => Number(value)).filter(Number.isFinite));
}

function readStagedTransactions(importFileId: number, importRowIds: number[] | null | undefined) {
  const selectedIds = toNumberSet(importRowIds);
  const rows = getDb().prepare(`
    SELECT id, importFileId, normalizedJson
    FROM importRows
    WHERE importFileId = @importFileId
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

export function previewImport({ fileName, text, customProfile = null }: PreviewImportOptions) {
  const parsed = parseCsv(text);
  if (!parsed.data.length) throw new Error('No data found in CSV');

  const headers = parsed.meta.fields || Object.keys(parsed.data[0] || {});
  const appParser = customProfile
    ? null
    : resolveImportParser({ fileName, headers, sample: text.slice(0, 4096) });

  if (appParser) {
    const parsedResult = appParser.parse({
      fileName,
      headers,
      rows: parsed.data,
      text,
    });
    const transactions = parsedResult.transactions.filter((transaction): transaction is ParsedImportTransaction => transaction !== null);
    if (!transactions.length) {
      throw new Error('Could not parse any valid transactions from this file.');
    }

    const preview = saveImportPreview({
      fileName,
      text,
      headers,
      parserName: appParser.id,
      sourceType: appParser.sourceType,
      parserPriority: appParser.priority,
      institution: appParser.institution,
      rawRows: parsed.data,
      parsedTransactions: parsedResult.transactions,
    });
    const previewTransactions = transactions.map(transaction =>
      toPreviewTransaction(transaction, preview.importFileId, preview.rowIds[transaction.sourceRowIndex])
    );

    return {
      importFileId: preview.importFileId,
      requiresMapping: false,
      profileUsed: appParser.name,
      headers,
      previewData: parsed.data.slice(0, 5),
      mapping: mappingFromProfile(null, headers),
      balances: parsedResult.balances,
      transactions: previewTransactions,
    };
  }

  const detectedProfile = detectBank(headers, fileName);
  const profile = customProfile || enhanceProfileWithHeaders(detectedProfile, headers);

  if (!profile) {
    const preview = saveImportPreview({
      fileName,
      text,
      headers,
      parserName: null,
      sourceType: null,
      parserPriority: null,
      institution: null,
      rawRows: parsed.data,
      parsedTransactions: parsed.data.map(() => null),
    });

    return {
      importFileId: preview.importFileId,
      requiresMapping: true,
      headers,
      previewData: parsed.data.slice(0, 5),
      balances: [],
    };
  }

  const parsedTransactions = parsed.data.map((row, sourceRowIndex) =>
    toParsedImportTransaction(normalizeTransaction(row, profile) as LegacyNormalizedTransaction | null, sourceRowIndex)
  );
  const transactions = parsedTransactions.filter((transaction): transaction is ParsedImportTransaction => transaction !== null);

  if (!transactions.length) {
    throw new Error('Could not parse any valid transactions from this file.');
  }

  const preview = saveImportPreview({
    fileName,
    text,
    headers,
    parserName: profile.name,
    sourceType: 'activity-export',
    parserPriority: 0,
    institution: profile.name,
    rawRows: parsed.data,
    parsedTransactions,
  });
  const previewTransactions = transactions.map(transaction =>
    toPreviewTransaction(transaction, preview.importFileId, preview.rowIds[transaction.sourceRowIndex])
  );

  return {
    importFileId: preview.importFileId,
    requiresMapping: false,
    profileUsed: profile.name,
    profile,
    headers,
    previewData: parsed.data.slice(0, 5),
    mapping: mappingFromProfile(profile, headers),
    balances: [],
    transactions: previewTransactions,
  };
}

export function materializeImportTransactions({
  accountId,
  importFileId: stagedImportFileId = null,
  importRowIds = null,
  transactions = [],
  fallbackImportFileId = null,
}: MaterializeImportTransactionsOptions) {
  if (!accountId) throw new Error('accountId is required');
  if (!Array.isArray(transactions)) throw new Error('transactions must be an array');
  if (importRowIds !== null && !Array.isArray(importRowIds)) throw new Error('importRowIds must be an array');

  const stagedTransactions = stagedImportFileId
    ? readStagedTransactions(stagedImportFileId, importRowIds)
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

    seen.add(fingerprint);
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
  const importFileId = stagedImportFileId || fallbackImportFileId || transactionsToCommit.find(transaction => transaction.importFileId)?.importFileId || null;

  db.transaction(() => {
    for (const transaction of unique) {
      const transactionId = insertRow('transactions', {
        ...transaction,
        importBatchId,
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

    if (importFileId) {
      updateRow('importFiles', importFileId, {
        status: 'committed',
        importBatchId,
        committedAt: now,
      });
    }
  })();

  return {
    importedCount: unique.length,
    skippedDuplicateCount: duplicates.length,
    importBatchId,
    insertedFingerprints: unique.map(transaction => transaction.fingerprint),
  };
}

export function commitImport({
  accountId,
  importFileId = null,
  importRowIds = null,
  transactions = [],
  importMeta = null,
}: CommitImportOptions) {
  const result = materializeImportTransactions({
    accountId,
    importFileId,
    importRowIds,
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
