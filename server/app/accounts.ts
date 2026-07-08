import { getDb } from '../database.ts';
import type { AccountAliasSummary, AccountListResponse, AccountSummary } from './types';

interface AccountRow {
  id: number;
  name: string;
  institution: string | null;
  type: string;
  balanceCents: number | null;
  latestBalanceMonth: string | null;
  currency: string | null;
  accountHolder: string | null;
  status: string | null;
  archivedAt: string | null;
  updatedAt: string | null;
}

interface AccountAliasRow {
  id: number;
  institution: string;
  alias: string;
  accountId: number;
}

export interface ListAccountsOptions {
  includeArchived?: boolean;
}

function toAccountSummary(row: AccountRow, aliases: AccountAliasSummary[]): AccountSummary {
  const status = row.status ?? 'active';
  return {
    id: row.id,
    name: row.name,
    institution: row.institution,
    type: row.type,
    balance: row.balanceCents === null ? 0 : row.balanceCents / 100,
    latestBalanceMonth: row.latestBalanceMonth,
    isClosed: status === 'closed' || (status !== 'archived' && row.balanceCents === 0 && row.latestBalanceMonth !== null),
    currency: row.currency ?? 'USD',
    accountHolder: row.accountHolder,
    status,
    archivedAt: row.archivedAt,
    updatedAt: row.updatedAt,
    aliases,
  };
}

function normalizeAccountMetadata(changes: Record<string, unknown>) {
  const allowed = new Set(['name', 'institution', 'type', 'currency', 'accountHolder']);
  const unsupported = Object.keys(changes).filter(field => !allowed.has(field));
  if (unsupported.length) {
    throw new Error(`Accounts only support metadata updates: ${unsupported.join(', ')}`);
  }

  const normalized: Record<string, string | null> = {};
  if ('name' in changes) {
    const name = String(changes.name || '').trim();
    if (!name) throw new Error('Account name is required.');
    normalized.name = name;
  }
  if ('institution' in changes) {
    const institution = changes.institution === null || changes.institution === undefined
      ? null
      : String(changes.institution).trim() || null;
    normalized.institution = institution;
  }
  if ('type' in changes) {
    const type = String(changes.type || '').trim();
    if (!type) throw new Error('Account type is required.');
    normalized.type = type;
  }
  if ('currency' in changes) {
    const currency = String(changes.currency || '').trim().toUpperCase();
    if (!currency) throw new Error('Account currency is required.');
    normalized.currency = currency;
  }
  if ('accountHolder' in changes) {
    const accountHolder = changes.accountHolder === null || changes.accountHolder === undefined
      ? null
      : String(changes.accountHolder).trim() || null;
    normalized.accountHolder = accountHolder;
  }

  return normalized;
}

function assertAccountExists(id: number) {
  const account = getDb().prepare('SELECT id FROM accounts WHERE id = ?').get(id) as { id: number } | undefined;
  if (!account) throw new Error(`Account not found: ${id}`);
}

export function listAccounts(options: ListAccountsOptions = {}): AccountListResponse {
  const where = options.includeArchived ? '' : "WHERE COALESCE(a.status, 'active') != 'archived'";
  const rows = getDb()
    .prepare(
      `SELECT
         a.id,
         a.name,
         a.institution,
         a.type,
         a.accountHolder,
         (
           SELECT lb.balanceCents
           FROM ledgerBalances lb
           WHERE lb.accountId = a.id
           ORDER BY lb.month DESC, lb.id DESC
           LIMIT 1
         ) AS balanceCents,
         (
           SELECT lb.month
           FROM ledgerBalances lb
           WHERE lb.accountId = a.id
           ORDER BY lb.month DESC, lb.id DESC
           LIMIT 1
         ) AS latestBalanceMonth,
         a.currency,
         COALESCE(a.status, 'active') AS status,
         a.archivedAt,
         a.updatedAt
       FROM accounts a
       ${where}
       ORDER BY a.name ASC, a.id ASC`
    )
    .all() as AccountRow[];

  const aliasesByAccountId = new Map<number, AccountAliasSummary[]>();
  if (rows.length) {
    const aliases = getDb().prepare(`
      SELECT id, institution, alias, accountId
      FROM accountAliases
      WHERE accountId IN (${rows.map(() => '?').join(', ')})
      ORDER BY institution ASC, alias ASC, id ASC
    `).all(...rows.map(row => row.id)) as AccountAliasRow[];

    for (const alias of aliases) {
      const accountAliases = aliasesByAccountId.get(alias.accountId) ?? [];
      accountAliases.push({
        id: alias.id,
        institution: alias.institution,
        alias: alias.alias,
      });
      aliasesByAccountId.set(alias.accountId, accountAliases);
    }
  }

  return { accounts: rows.map(row => toAccountSummary(row, aliasesByAccountId.get(row.id) ?? [])) };
}

export function updateAccountMetadata(id: number | string, changes: Record<string, unknown>) {
  const accountId = Number(id);
  if (!Number.isFinite(accountId)) throw new Error('Invalid account id');
  const metadata = normalizeAccountMetadata(changes);
  assertAccountExists(accountId);
  if (!Object.keys(metadata).length) return { ok: true, accountId };

  getDb().prepare(`
    UPDATE accounts
    SET ${Object.keys(metadata).map(field => `${field} = @${field}`).join(', ')},
        updatedAt = @updatedAt
    WHERE id = @id
  `).run({
    ...metadata,
    updatedAt: new Date().toISOString(),
    id: accountId,
  });

  return { ok: true, accountId };
}

export function archiveAccount(id: number | string) {
  const accountId = Number(id);
  if (!Number.isFinite(accountId)) throw new Error('Invalid account id');
  assertAccountExists(accountId);
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE accounts
    SET status = 'archived',
        archivedAt = COALESCE(archivedAt, @now),
        updatedAt = @now
    WHERE id = @id
  `).run({ id: accountId, now });
  return { ok: true, accountId };
}

export function closeAccount(id: number | string) {
  const accountId = Number(id);
  if (!Number.isFinite(accountId)) throw new Error('Invalid account id');
  assertAccountExists(accountId);
  getDb().prepare(`
    UPDATE accounts
    SET status = 'closed',
        archivedAt = NULL,
        updatedAt = @now
    WHERE id = @id
  `).run({ id: accountId, now: new Date().toISOString() });
  return { ok: true, accountId };
}

export function unarchiveAccount(id: number | string) {
  const accountId = Number(id);
  if (!Number.isFinite(accountId)) throw new Error('Invalid account id');
  assertAccountExists(accountId);
  getDb().prepare(`
    UPDATE accounts
    SET status = 'active',
        archivedAt = NULL,
        updatedAt = @now
    WHERE id = @id
  `).run({ id: accountId, now: new Date().toISOString() });
  return { ok: true, accountId };
}
