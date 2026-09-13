import type { getDb } from '../database';
import type { RebuiltLedger } from './ledgerRebuild';

type Db = ReturnType<typeof getDb>;
export interface ConflictMember {
  sourceFileId: number; fileName: string; accountId: number; accountName: string;
  date: string; amountCents: number; description: string;
}
export interface RefreshConflict {
  kind: 'transaction' | 'balance'; key: string; members: ConflictMember[];
}
export interface RefreshDiagnostics {
  inputRevision: string; generatedAt: string;
  conflicts: Array<RefreshConflict & { origin: 'existing' | 'new' }>;
  resolved: RefreshConflict[];
}

// Snapshot evidence while candidate rows still exist: their database IDs are
// temporary and must never be used to compare pre/post-refresh conflicts.
export function captureRefreshConflicts(db: Db, ledger: RebuiltLedger): RefreshConflict[] {
  const conflicts: RefreshConflict[] = [];
  const add = (kind: RefreshConflict['kind'], ids: number[]) => {
    const table = kind === 'transaction' ? 'sourceTransactions' : 'sourceBalances';
    const amount = kind === 'transaction' ? 'amountCents' : 'balanceCents';
    const members = ids.map(id => db.prepare(`SELECT f.sourceFileId, sf.fileName, sa.accountId,
      a.name AS accountName, f.date, f.${amount} AS amountCents,
      ${kind === 'transaction' ? 'f.description' : "''"} AS description
      FROM ${table} f JOIN sourceFiles sf ON sf.id=f.sourceFileId
      JOIN sourceAccounts sa ON sa.id=f.sourceAccountId JOIN accounts a ON a.id=sa.accountId
      WHERE f.id=?`).get(id) as ConflictMember);
    // Preserve occurrence multiplicity, but ignore regenerated IDs and prose.
    const key = JSON.stringify([kind, members.map(m =>
      [m.sourceFileId, m.accountId, m.date, m.amountCents]).sort()]);
    conflicts.push({ kind, key, members });
  };
  // Ambiguity records are directed edges. Report connected groups once, rather
  // than counting both directions or every competing match as separate errors.
  const graph = new Map<number, Set<number>>();
  for (const ambiguity of ledger.ambiguities ?? []) {
    for (const other of ambiguity.candidateSourceTransactionIds) {
      for (const [a, b] of [[ambiguity.sourceTransactionId, other], [other, ambiguity.sourceTransactionId]] as const) {
        if (!graph.has(a)) graph.set(a, new Set());
        graph.get(a)!.add(b);
      }
    }
  }
  const seen = new Set<number>();
  for (const id of graph.keys()) {
    if (seen.has(id)) continue;
    const group: number[] = [], pending = [id];
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next); group.push(next);
      pending.push(...graph.get(next)!);
    }
    add('transaction', group);
  }
  for (const conflict of ledger.balanceConflicts ?? []) add('balance', conflict.sourceBalanceIds);
  return conflicts;
}

export function compareRefreshConflicts(before: RefreshConflict[], after: RefreshConflict[], inputRevision: string): RefreshDiagnostics {
  const oldKeys = new Set(before.map(c => c.key)), newKeys = new Set(after.map(c => c.key));
  return {
    inputRevision, generatedAt: new Date().toISOString(),
    conflicts: after.map(c => ({ ...c, origin: oldKeys.has(c.key) ? 'existing' : 'new' })),
    resolved: before.filter(c => !newKeys.has(c.key)),
  };
}

export function readRefreshDiagnostics(db: Db): RefreshDiagnostics | null {
  const row = db.prepare('SELECT payloadJson FROM parserRefreshDiagnostics WHERE id=1').get();
  return row ? JSON.parse(row.payloadJson) as RefreshDiagnostics : null;
}
