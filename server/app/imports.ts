import Papa from 'papaparse';
import { getDb, hashContent, insertRow, listRows, updateRow } from '../database.js';
import { categorizeTransactions } from '../../src/utils/categorizer.js';
import {
  detectBank,
  enhanceProfileWithHeaders,
  mappingFromProfile,
  normalizeTransaction,
} from '../../src/utils/bankProfiles.js';

interface ImportProfile {
  name: string;
  statementType?: string;
  dateColumns?: string[];
  dateFormats?: string[];
  descriptionColumn?: string;
  merchantColumn?: string;
  categoryColumn?: string | null;
  amountConfig?: Record<string, unknown>;
}

interface PreviewImportOptions {
  fileName: string;
  text: string;
  customProfile?: ImportProfile | null;
  inferCategories?: boolean;
}

interface PreviewTransaction {
  importFileId?: number | null;
  importRowId?: number | null;
  sourceRowIndex?: number | null;
  date: string;
  amount: number;
  description?: string | null;
  merchant?: string | null;
  originalDescription?: string | null;
  originalCategory?: string | null;
  categoryId?: number | null;
  type?: string | null;
  transactionKind?: string | null;
  status?: string | null;
  notes?: string | null;
  fingerprint?: string | null;
}

interface CommitImportOptions {
  accountId: number;
  transactions: PreviewTransaction[];
  importMeta?: {
    importFileId?: number | null;
    headers?: string[];
    profile?: ImportProfile | null;
    mapping?: Record<string, unknown> | null;
    profileName?: string | null;
  } | null;
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

function getHeaderSignature(headers: string[] = []) {
  return headers.map(header => normalizeText(header)).join('|');
}

function getTransactionFingerprint(transaction: PreviewTransaction, accountId: number) {
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

function saveImportPreview({
  fileName,
  text,
  headers,
  parserName,
  rawRows,
  normalizedRows,
}: {
  fileName: string;
  text: string;
  headers: string[];
  parserName: string | null;
  rawRows: Array<Record<string, string>>;
  normalizedRows: Array<PreviewTransaction | null>;
}) {
  const now = new Date().toISOString();
  const headerSignature = getHeaderSignature(headers);
  const importFileId = insertRow('importFiles', {
    fileName,
    contentHash: hashContent(text),
    parserName,
    headerSignature,
    rowCount: rawRows.length,
    status: 'previewed',
    createdAt: now,
  });

  const rowIds: number[] = [];
  for (const [index, row] of rawRows.entries()) {
    const importRowId = insertRow('importRows', {
      importFileId,
      rowIndex: index,
      rawJson: JSON.stringify(row),
      normalizedJson: normalizedRows[index] ? JSON.stringify(normalizedRows[index]) : null,
      createdAt: now,
    });
    rowIds[index] = Number(importRowId);
  }

  return { importFileId: Number(importFileId), rowIds };
}

export function previewImport({ fileName, text, customProfile = null, inferCategories = true }: PreviewImportOptions) {
  const parsed = parseCsv(text);
  if (!parsed.data.length) throw new Error('No data found in CSV');

  const headers = parsed.meta.fields || Object.keys(parsed.data[0] || {});
  const detectedProfile = detectBank(headers, fileName);
  const profile = customProfile || enhanceProfileWithHeaders(detectedProfile, headers);

  if (!profile) {
    const preview = saveImportPreview({
      fileName,
      text,
      headers,
      parserName: null,
      rawRows: parsed.data,
      normalizedRows: parsed.data.map(() => null),
    });

    return {
      importFileId: preview.importFileId,
      requiresMapping: true,
      headers,
      previewData: parsed.data.slice(0, 5),
    };
  }

  const normalizedRows = parsed.data.map(row => normalizeTransaction(row, profile));
  let indexedTransactions = normalizedRows
    .map((transaction, sourceRowIndex) => transaction ? { sourceRowIndex, transaction } : null)
    .filter((item): item is { sourceRowIndex: number; transaction: PreviewTransaction } => item !== null);

  if (!indexedTransactions.length) {
    throw new Error('Could not parse any valid transactions from this file.');
  }

  if (inferCategories) {
    const categorized = categorizeTransactions(
      indexedTransactions.map(item => item.transaction),
      listRows('categorizationRules'),
      listRows('categories')
    );
    indexedTransactions = indexedTransactions.map((item, index) => ({
      ...item,
      transaction: categorized[index],
    }));
  }

  const preview = saveImportPreview({
    fileName,
    text,
    headers,
    parserName: profile.name,
    rawRows: parsed.data,
    normalizedRows: parsed.data.map((_, index) =>
      indexedTransactions.find(item => item.sourceRowIndex === index)?.transaction || null
    ),
  });
  const transactions = indexedTransactions.map(({ sourceRowIndex, transaction }) => ({
    ...transaction,
    importFileId: preview.importFileId,
    importRowId: preview.rowIds[sourceRowIndex],
    sourceRowIndex,
  }));

  return {
    importFileId: preview.importFileId,
    requiresMapping: false,
    profileUsed: profile.name,
    profile,
    headers,
    previewData: parsed.data.slice(0, 5),
    inferCategories,
    mapping: mappingFromProfile(profile, headers),
    transactions,
  };
}

export function commitImport({ accountId, transactions, importMeta = null }: CommitImportOptions) {
  if (!accountId) throw new Error('accountId is required');
  if (!Array.isArray(transactions)) throw new Error('transactions must be an array');

  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as
    | { id: number; type?: string | null; currentBalance?: number | null }
    | undefined;
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const existing = db.prepare('SELECT * FROM transactions WHERE accountId = ?').all(accountId) as PreviewTransaction[];
  const seen = new Set(existing.map(transaction =>
    transaction.fingerprint || getTransactionFingerprint(transaction, accountId)
  ));

  const unique: Array<PreviewTransaction & { accountId: number; importBatchId: string; fingerprint: string }> = [];
  const duplicates: Array<PreviewTransaction & { fingerprint: string }> = [];

  for (const transaction of transactions.filter(item => item && item.date && typeof item.amount === 'number')) {
    const fingerprint = getTransactionFingerprint(transaction, accountId);
    const withFingerprint = { ...transaction, fingerprint };
    if (seen.has(fingerprint)) {
      duplicates.push(withFingerprint);
      continue;
    }

    seen.add(fingerprint);
    unique.push({
      ...withFingerprint,
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
    unique[0]?.date || transactions[0]?.date || 'unknown-start',
    unique.at(-1)?.date || transactions.at(-1)?.date || 'unknown-end',
    transactions.length,
  ].join('-');
  const now = new Date().toISOString();
  const totalAmount = unique.reduce((sum, transaction) => sum + transaction.amount, 0);
  const importFileId = importMeta?.importFileId || transactions.find(transaction => transaction.importFileId)?.importFileId || null;

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

    if (importMeta?.headers?.length && importMeta.profile) {
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
