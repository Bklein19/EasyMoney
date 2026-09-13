import type { getDb } from '../database';
import type { RebuiltLedger } from './ledgerRebuild';

type Db = ReturnType<typeof getDb>;
interface Evidence {
  id: number; sourceFileId: number; accountId: number; rowIndex: number | null;
  date: string; amountCents: number; description: string; rawJson: string | null;
}
interface Annotation { ledgerTransactionId: string; categoryId: number | null; notes: string | null; createdAt: string | null; updatedAt: string | null }
export interface AnnotationSnapshot { annotation: Annotation; transaction: Record<string, unknown>; sources: Evidence[]; excluded: boolean }
export interface AnnotationDisposition {
  ledgerTransactionId: string; disposition: 'unchanged' | 'transferred' | 'retained-history' | 'review-required';
  targetId: string | null; reason: string; evidence: AnnotationSnapshot;
}
const sourceQuery = `SELECT st.id,st.sourceFileId,sa.accountId,ir.rowIndex,st.date,st.amountCents,st.description,st.rawJson
  FROM sourceTransactions st JOIN sourceAccounts sa ON sa.id=st.sourceAccountId
  JOIN sourceFiles sf ON sf.id=st.sourceFileId LEFT JOIN importRows ir ON ir.id=st.importRowId WHERE sf.status='committed'`;

export function captureAnnotations(db: Db, baseline: RebuiltLedger): AnnotationSnapshot[] {
  const sources = new Map((db.prepare(sourceQuery).all() as unknown as Evidence[]).map(row => [row.id,row]));
  const provenance = new Map<string, Evidence[]>();
  for (const row of db.prepare('SELECT ledgerTransactionId,sourceTransactionId FROM ledgerProvenance').all()) {
    const evidence = sources.get(row.sourceTransactionId);
    if (evidence) provenance.set(row.ledgerTransactionId,[...(provenance.get(row.ledgerTransactionId) ?? []),evidence]);
  }
  const transactions = new Map(db.prepare('SELECT * FROM ledgerTransactions').all().map(row => [String(row.ledgerTransactionId),row]));
  const excluded = new Set(baseline.exclusions?.map(row => row.sourceTransactionId));
  return (db.prepare('SELECT * FROM transactionAnnotations').all() as unknown as Annotation[])
    .filter(annotation => transactions.has(annotation.ledgerTransactionId))
    .map(annotation => {
      const evidence = provenance.get(annotation.ledgerTransactionId) ?? [];
      return { annotation, transaction:transactions.get(annotation.ledgerTransactionId)!, sources:evidence,
        excluded:evidence.length > 0 && evidence.every(row => excluded.has(row.id)) };
    });
}

function withoutPageFurniture(description: string) {
  return description.replace(/\s+continued on the next page\b.*$/i,'')
    .replace(/\s+(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}, (?:monthly transaction|quarter-to-date) statement\b.*$/i,'')
    .replace(/\s+Ending balance on \d{1,2}\/\d{1,2}\s*$/i,'')
    .replace(/\s+/g,' ').trim();
}

function reference(row: Evidence) {
  let source: string | undefined;
  try {source=JSON.parse(row.rawJson ?? '{}').source;} catch {return null;}
  if(source!=='wells-fargo-statement') return null;
  // These are transaction references printed in the source, not hashes of a
  // parsed description. Ignore unrelated continuation fragments after them.
  const explicit=row.description.match(/\bRef\s*#([A-Za-z0-9]{8,})\b/i)?.[1];
  if(explicit) return `ref:${explicit}`;
  const venmo=row.description.match(/^Venmo Payment (?:\d{6} )?(\d{9,})\b/i)?.[1];
  if(venmo) return `venmo:${venmo}`;
  const card=/^Purchase\b/i.test(row.description) ? row.description.match(/\b([PS]\d{12,})\s+Card\b/)?.[1] : null;
  return card ? `card:${card}` : null;
}

function sameOccurrence(old: Evidence, next: Evidence) {
  if (old.accountId !== next.accountId || old.sourceFileId !== next.sourceFileId || old.date.slice(0,10) !== next.date.slice(0,10)) return false;
  const oldReference=reference(old), newReference=reference(next);
  if(oldReference && newReference && oldReference===newReference) return true;
  const sameValue = old.amountCents === next.amountCents;
  const sameDescription = withoutPageFurniture(old.description ?? '') === withoutPageFurniture(next.description ?? '');
  if(sameDescription && Math.abs(old.amountCents)===Math.abs(next.amountCents)) return true;
  // A row offset alone is not lineage. Require the same economic row as well;
  // description changes require matching non-empty source evidence.
  let sameRaw = false;
  if (old.rawJson && old.rawJson === next.rawJson) {
    try {
      const raw: unknown = JSON.parse(old.rawJson);
      sameRaw = Boolean(raw && typeof raw === 'object' && Object.entries(raw).some(([key,value]) =>
        !['source','type','transactionKind','transactionType'].includes(key) && value !== null && value !== ''));
    } catch { /* Unreadable evidence cannot justify a transfer. */ }
  }
  return sameValue && sameRaw && old.rowIndex !== null && old.rowIndex === next.rowIndex;
}

export function planAnnotationRefresh(db: Db, before: AnnotationSnapshot[], ledger: RebuiltLedger): AnnotationDisposition[] {
  const ids = new Set(ledger.transactions.map(row => row.ledgerTransactionId));
  const targets = new Map((ledger.provenance ?? []).map(row => [row.sourceTransactionId,row.ledgerTransactionId]));
  const sources = new Map<number, Evidence[]>();
  for (const row of db.prepare(sourceQuery).all() as unknown as Evidence[]) sources.set(row.sourceFileId,[...(sources.get(row.sourceFileId) ?? []),row]);
  const dispositions: AnnotationDisposition[] = before.map(evidence => {
    const id = evidence.annotation.ledgerTransactionId;
    if (ids.has(id)) return {ledgerTransactionId:id,disposition:'unchanged',targetId:id,reason:'Stable ledger identity',evidence};
    const matches = new Set(evidence.sources.flatMap(old => {
      const candidates=(sources.get(old.sourceFileId) ?? []).filter(next=>sameOccurrence(old,next));
      const positional=candidates.filter(next=>old.rowIndex!==null && next.rowIndex===old.rowIndex);
      return (candidates.length>1 && positional.length===1 ? positional : candidates)
        .map(next=>targets.get(next.id)).filter((id):id is string=>Boolean(id));
    }));
    if (matches.size === 1) return {ledgerTransactionId:id,disposition:'transferred',targetId:[...matches][0]!,reason:'Same original document occurrence and economic evidence',evidence};
    if (matches.size === 0 && evidence.excluded) return {ledgerTransactionId:id,disposition:'retained-history',targetId:null,reason:'Intentionally excluded non-transaction summary; not copied to a purchase',evidence};
    return {ledgerTransactionId:id,disposition:'review-required',targetId:null,reason:matches.size > 1 ? 'Prior annotation now spans multiple transactions' : 'No unambiguous source-occurrence destination',evidence};
  });
  const groups = new Map<string,AnnotationDisposition[]>();
  for (const row of dispositions) if(row.targetId) groups.set(row.targetId,[...(groups.get(row.targetId) ?? []),row]);
  for (const [targetId,rows] of groups) {
    // Include retained annotations that may be returning after an unimport.
    const prior = db.prepare('SELECT * FROM transactionAnnotations WHERE ledgerTransactionId=?').get(targetId) as Annotation | undefined;
    const values = [...rows.map(row=>row.evidence.annotation), ...(prior?[prior]:[])];
    const categories = new Set(values.map(row=>row.categoryId).filter(value=>value!==null));
    const notes = new Set(values.map(row=>row.notes).filter((value):value is string=>Boolean(value?.trim())));
    const occurrences=new Map<number,Set<number>>();
    for(const row of rows) for(const source of row.evidence.sources) {
      if(!occurrences.has(source.sourceFileId)) occurrences.set(source.sourceFileId,new Set());
      occurrences.get(source.sourceFileId)!.add(source.id);
    }
    const collapsedOccurrences=rows.some(row=>row.disposition==='transferred') && [...occurrences.values()].some(ids=>ids.size>1);
    if(categories.size>1 || notes.size>1 || collapsedOccurrences) for(const row of rows) {
      row.disposition='review-required'; row.reason=collapsedOccurrences ? 'Multiple original occurrences would share one annotation destination' : 'Conflicting categories or non-empty notes require review';
    }
  }
  return dispositions;
}

export function applyAnnotationRefresh(db: Db, dispositions: AnnotationDisposition[], inputRevision: string) {
  if(dispositions.some(row=>row.disposition==='review-required')) throw new Error('Annotation review is required.');
  for(const row of dispositions) {
    if(row.disposition==='unchanged') continue;
    db.prepare(`INSERT INTO parserAnnotationHistory(inputRevision,ledgerTransactionId,targetId,disposition,evidenceJson,createdAt)
      VALUES(?,?,?,?,?,?)`).run(inputRevision,row.ledgerTransactionId,row.targetId,row.disposition,JSON.stringify(row),new Date().toISOString());
    if(row.disposition==='transferred') {
      const a=row.evidence.annotation;
      db.prepare(`INSERT INTO transactionAnnotations(ledgerTransactionId,categoryId,notes,createdAt,updatedAt) VALUES(?,?,?,?,?)
        ON CONFLICT(ledgerTransactionId) DO UPDATE SET categoryId=COALESCE(transactionAnnotations.categoryId,excluded.categoryId),
        notes=CASE WHEN trim(COALESCE(transactionAnnotations.notes,''))='' THEN excluded.notes ELSE transactionAnnotations.notes END`)
        .run(row.targetId,a.categoryId,a.notes,a.createdAt,a.updatedAt);
    }
    // Original annotations remain durable, including excluded summaries.
  }
}

export function readAnnotationHistory(db: Db) {
  return db.prepare('SELECT id,createdAt,evidenceJson FROM parserAnnotationHistory ORDER BY id DESC').all()
    .map(row=>({id:Number(row.id),createdAt:String(row.createdAt),...JSON.parse(row.evidenceJson) as AnnotationDisposition}));
}
