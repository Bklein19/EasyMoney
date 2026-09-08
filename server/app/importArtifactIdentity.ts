import { getDb } from '../database.ts';
import { hashContent } from '../hash.ts';

type AppDatabase = ReturnType<typeof getDb>;

interface ArtifactMetadataRow {
  importFileId: number;
  parserName: string | null;
  sourceType: string | null;
  parserPriority: number | null;
  institution: string | null;
  coveredFrom: string | null;
  coveredTo: string | null;
  coverageBasis: string | null;
}

interface ArtifactAccountRow {
  institution: string | null;
  sourceAccountKey: string;
  sourceAccountName: string | null;
  accountHolder: string | null;
}

interface ArtifactTransactionRow {
  accountInstitution: string | null;
  sourceAccountKey: string;
  date: string;
  amountCents: number;
  description: string | null;
  sourceRole: string | null;
  priority: number | null;
  rawJson: string | null;
}

interface ArtifactBalanceRow {
  accountInstitution: string | null;
  sourceAccountKey: string;
  date: string;
  balanceCents: number;
  priority: number | null;
}

const transactionSemanticRawKeys = [
  'category',
  'crossSourceIdentity',
  'merchant',
  'metric',
  'moneyCategory',
  'moneyId',
  'originalCategory',
  'originalDescription',
  'status',
  'transactionKind',
  'type',
] as const;

function normalizedOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizedRequiredText(value: string): string {
  return value.trim();
}

function semanticTransactionRaw(rawJson: string | null): Record<string, unknown> {
  if (!rawJson) return {};
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    return Object.fromEntries(transactionSemanticRawKeys
      .filter(key => parsed[key] !== undefined)
      .map(key => [key, canonicalJsonValue(parsed[key])]));
  } catch {
    return {};
  }
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalJsonValue(nestedValue)]));
  }
  return value;
}

function sortedCanonicalRows(rows: unknown[]): unknown[] {
  return rows
    .map(row => JSON.stringify(row))
    .sort()
    .map(row => JSON.parse(row) as unknown);
}

function artifactMetadata(importFileId: number, db: AppDatabase): ArtifactMetadataRow | null {
  const row = db.prepare(`
    SELECT
      sf.importFileId,
      sf.parserName,
      sf.sourceType,
      sf.parserPriority,
      sf.institution,
      sf.coveredFrom,
      sf.coveredTo,
      sf.coverageBasis
    FROM sourceFiles sf
    WHERE sf.importFileId = ?
  `).get(importFileId) as ArtifactMetadataRow | undefined;
  return row ?? null;
}

export function canonicalImportArtifactFacts(
  importFileId: number,
  db: AppDatabase = getDb(),
): Record<string, unknown> | null {
  const metadata = artifactMetadata(importFileId, db);
  if (!metadata) return null;

  const accounts = db.prepare(`
    SELECT institution, sourceAccountKey, sourceAccountName, accountHolder
    FROM sourceAccounts
    WHERE sourceFileId = (SELECT id FROM sourceFiles WHERE importFileId = ?)
  `).all(importFileId) as ArtifactAccountRow[];
  const transactions = db.prepare(`
    SELECT
      sa.institution AS accountInstitution,
      sa.sourceAccountKey,
      st.date,
      st.amountCents,
      st.description,
      st.sourceRole,
      st.priority,
      st.rawJson
    FROM sourceTransactions st
    JOIN sourceAccounts sa ON sa.id = st.sourceAccountId
    JOIN sourceFiles sf ON sf.id = st.sourceFileId
    WHERE sf.importFileId = ?
  `).all(importFileId) as ArtifactTransactionRow[];
  const balances = db.prepare(`
    SELECT
      sa.institution AS accountInstitution,
      sa.sourceAccountKey,
      sb.date,
      sb.balanceCents,
      sb.priority
    FROM sourceBalances sb
    JOIN sourceAccounts sa ON sa.id = sb.sourceAccountId
    JOIN sourceFiles sf ON sf.id = sb.sourceFileId
    WHERE sf.importFileId = ?
  `).all(importFileId) as ArtifactBalanceRow[];

  return {
    parser: {
      name: normalizedOptionalText(metadata.parserName),
      sourceType: normalizedOptionalText(metadata.sourceType),
      priority: metadata.parserPriority === null ? null : Number(metadata.parserPriority),
      institution: normalizedOptionalText(metadata.institution),
    },
    coverage: {
      from: normalizedOptionalText(metadata.coveredFrom),
      to: normalizedOptionalText(metadata.coveredTo),
      basis: normalizedOptionalText(metadata.coverageBasis),
    },
    accounts: sortedCanonicalRows(accounts.map(account => ({
      institution: normalizedOptionalText(account.institution),
      key: normalizedRequiredText(account.sourceAccountKey),
      name: normalizedOptionalText(account.sourceAccountName),
      holder: normalizedOptionalText(account.accountHolder),
    }))),
    transactions: sortedCanonicalRows(transactions.map(transaction => ({
      account: {
        institution: normalizedOptionalText(transaction.accountInstitution),
        key: normalizedRequiredText(transaction.sourceAccountKey),
      },
      date: normalizedRequiredText(transaction.date),
      amountCents: Number(transaction.amountCents),
      description: normalizedOptionalText(transaction.description),
      sourceRole: normalizedOptionalText(transaction.sourceRole),
      priority: transaction.priority === null ? null : Number(transaction.priority),
      raw: semanticTransactionRaw(transaction.rawJson),
    }))),
    balances: sortedCanonicalRows(balances.map(balance => ({
      account: {
        institution: normalizedOptionalText(balance.accountInstitution),
        key: normalizedRequiredText(balance.sourceAccountKey),
      },
      date: normalizedRequiredText(balance.date),
      balanceCents: Number(balance.balanceCents),
      priority: balance.priority === null ? null : Number(balance.priority),
    }))),
  };
}

export function importArtifactFactFingerprint(
  importFileId: number,
  db: AppDatabase = getDb(),
): string | null {
  const facts = canonicalImportArtifactFacts(importFileId, db);
  return facts ? hashContent(JSON.stringify(facts)) : null;
}

export function findCommittedImportArtifactFactDuplicate(
  importFileId: number,
  db: AppDatabase = getDb(),
): number | null {
  const metadata = artifactMetadata(importFileId, db);
  if (!metadata) return null;
  const fingerprint = importArtifactFactFingerprint(importFileId, db);
  if (!fingerprint) return null;

  const candidates = db.prepare(`
    SELECT ifs.id
    FROM importFiles ifs
    JOIN sourceFiles sf ON sf.importFileId = ifs.id
    WHERE ifs.id <> @importFileId
      AND ifs.status = 'committed'
      AND sf.status = 'committed'
      AND sf.parserName IS @parserName
      AND sf.sourceType IS @sourceType
      AND sf.parserPriority IS @parserPriority
      AND sf.institution IS @institution
      AND sf.coveredFrom IS @coveredFrom
      AND sf.coveredTo IS @coveredTo
      AND sf.coverageBasis IS @coverageBasis
    ORDER BY ifs.committedAt DESC, ifs.id DESC
  `).all(metadata) as Array<{ id: number }>;
  for (const candidate of candidates) {
    if (importArtifactFactFingerprint(candidate.id, db) === fingerprint) return candidate.id;
  }
  return null;
}

export function findCommittedImportArtifactDuplicate(
  importFileId: number,
  db: AppDatabase = getDb(),
): number | null {
  const exact = db.prepare(`
    SELECT committedFile.id
    FROM importFiles currentFile
    JOIN importFiles committedFile ON committedFile.contentHash = currentFile.contentHash
    JOIN sourceFiles committedSource ON committedSource.importFileId = committedFile.id
    WHERE currentFile.id = ?
      AND committedFile.id <> currentFile.id
      AND committedFile.status = 'committed'
      AND committedSource.status = 'committed'
    ORDER BY committedFile.committedAt DESC, committedFile.id DESC
    LIMIT 1
  `).get(importFileId) as { id: number } | undefined;
  return exact?.id ?? findCommittedImportArtifactFactDuplicate(importFileId, db);
}

export function discardImportArtifactPreview(
  importFileId: number,
  db: AppDatabase = getDb(),
): void {
  db.prepare(`
    UPDATE sourceFiles
    SET status = 'discarded'
    WHERE importFileId = ? AND status = 'previewed'
  `).run(importFileId);
  db.prepare(`
    UPDATE importFiles
    SET status = 'discarded'
    WHERE id = ? AND status = 'previewed'
  `).run(importFileId);
}
