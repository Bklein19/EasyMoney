import type { getDb } from '../database';

export interface StatementCashFlow {
  from: string;
  to: string;
  netContributionsCents: number;
}
export function readStatementCashFlow(raw: Record<string, unknown>): StatementCashFlow | null {
  if (!raw.statementCashFlow) return null;
  const flow = raw.statementCashFlow as StatementCashFlow;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(flow.from) || !/^\d{4}-\d{2}-\d{2}$/.test(flow.to) || flow.from > flow.to || !Number.isSafeInteger(flow.netContributionsCents)) throw new Error('Invalid statement cash-flow evidence');
  return flow;
}
export function selectStatementCashFlows(input: StatementCashFlow[]): StatementCashFlow[] {
  const unique = new Map<string, StatementCashFlow>();
  for (const flow of input) {
    const key = `${flow.from}/${flow.to}`;
    const prior = unique.get(key);
    if (prior && prior.netContributionsCents !== flow.netContributionsCents) throw new Error('Statements disagree on contribution totals');
    unique.set(key, flow);
  }
  const sorted = [...unique.values()].sort((a,b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const result: StatementCashFlow[] = [];
  for (const flow of sorted) {
    if (result.some(prior => prior.to >= flow.from)) throw new Error('Overlapping statement contribution periods need review');
    result.push(flow);
  }
  return result;
}

export function getStatementCashFlows(db: ReturnType<typeof getDb>): Map<number, StatementCashFlow[]> {
  const rows = db.prepare(`SELECT sa.accountId, sb.rawJson FROM sourceBalances sb
    JOIN sourceAccounts sa ON sa.id=sb.sourceAccountId JOIN sourceFiles sf ON sf.id=sb.sourceFileId
    WHERE sf.status='committed' AND sa.accountId IS NOT NULL`).all() as {accountId:number;rawJson:string|null}[];
  const grouped = new Map<number, StatementCashFlow[]>();
  for (const row of rows) {
    const flow = readStatementCashFlow(JSON.parse(row.rawJson || '{}'));
    if (flow) grouped.set(row.accountId, [...(grouped.get(row.accountId) ?? []), flow]);
  }
  return new Map([...grouped].map(([id, flows]) => [id, selectStatementCashFlows(flows)]));
}
