import type { getDb } from '../database';
import type { parsedSourceAccountIdentity } from './imports';

type Db = ReturnType<typeof getDb>;
type Identity = ReturnType<typeof parsedSourceAccountIdentity>;
export interface RefreshAccount {
  id: number; accountId: number | null; institution: string; sourceAccountKey: string;
  sourceAccountName: string | null; accountHolder: string | null;
}

/** A user-confirmed exception is bound to the original file, never a global suffix guess. */
export function approveRefreshAccountChoice(db: Db, input: {
  sourceFileId: number; contentHash: string; institution: string; sourceAccountKey: string;
  accountId: number; approvalNote: string;
}) {
  if (!input.approvalNote.trim()) throw new Error('An explicit account approval is required.');
  const existing = db.prepare(`SELECT 1 FROM sourceFiles sf JOIN sourceAccounts sa ON sa.sourceFileId=sf.id
    WHERE sf.id=? AND sf.contentHash=? AND sa.institution=? AND sa.accountId=?`).get(
    input.sourceFileId, input.contentHash, input.institution, input.accountId);
  if (!existing) throw new Error('The approved choice does not preserve this original file mapping.');
  const prior = db.prepare('SELECT accountId,contentHash FROM parserRefreshAccountChoices WHERE sourceFileId=? AND sourceAccountKey=?')
    .get(input.sourceFileId, input.sourceAccountKey);
  if (prior && (prior.accountId !== input.accountId || prior.contentHash !== input.contentHash)) throw new Error('A different account choice already exists.');
  db.prepare(`INSERT OR IGNORE INTO parserRefreshAccountChoices
    (sourceFileId,contentHash,institution,sourceAccountKey,accountId,approvalNote,approvedAt) VALUES(?,?,?,?,?,?,?)`)
    .run(input.sourceFileId,input.contentHash,input.institution,input.sourceAccountKey,input.accountId,input.approvalNote,new Date().toISOString());
}

export function resolveRefreshAccount(db: Db, file: { id: number; contentHash: string }, identity: Identity, accounts: RefreshAccount[], allowLegacyName = false) {
  const compatible = (account: RefreshAccount) => {
    const owner = account.accountId ? db.prepare('SELECT accountHolder FROM accounts WHERE id=?').get(account.accountId)?.accountHolder : null;
    return account.institution === identity.institution &&
      (!account.accountHolder || !identity.accountHolder || account.accountHolder === identity.accountHolder) &&
      (!owner || !identity.accountHolder || owner === identity.accountHolder);
  };
  const local = accounts.filter(account => compatible(account) && account.accountId);
  const exact = local.filter(account => account.sourceAccountKey === identity.remoteAccountId ||
    (allowLegacyName && identity.accountName !== 'Selected account' && account.sourceAccountName === identity.accountName));
  if (exact.length === 1) return { accountId: exact[0]!.accountId!, sourceAccountId: exact[0]!.id, evidence: 'unchanged identity' };
  if (exact.length > 1) throw new Error('Ambiguous source identities.');
  const approved = db.prepare(`SELECT accountId FROM parserRefreshAccountChoices
    WHERE sourceFileId=? AND contentHash=? AND institution=? AND sourceAccountKey=?`)
    .get(file.id,file.contentHash,identity.institution,identity.remoteAccountId);
  const global = (db.prepare(`SELECT sa.* FROM sourceAccounts sa JOIN sourceFiles sf ON sf.id=sa.sourceFileId
    WHERE sa.institution=? AND sa.sourceAccountKey=? AND sa.accountId IS NOT NULL AND sf.status='committed'`)
    .all(identity.institution,identity.remoteAccountId) as unknown as RefreshAccount[]).filter(compatible);
  const destinations = new Set(global.map(account => account.accountId!));
  const accountId = approved ? Number(approved.accountId) : destinations.size === 1 ? [...destinations][0]! : null;
  if (!accountId || !local.some(account => account.accountId === accountId) ||
    (destinations.size > 0 && (destinations.size !== 1 || !destinations.has(accountId)))) throw new Error('Unconfirmed account identity.');
  const owner = db.prepare('SELECT accountHolder FROM accounts WHERE id=?').get(accountId)?.accountHolder;
  if (owner && identity.accountHolder && owner !== identity.accountHolder) throw new Error('Account owner changed.');
  return { accountId, sourceAccountId: null, evidence: approved ? 'explicit original-bound choice' : 'previously confirmed identity' };
}
