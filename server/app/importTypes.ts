export interface ImportProfile {
  name: string;
  statementType?: string;
  dateColumns?: string[];
  dateFormats?: string[];
  descriptionColumn?: string;
  merchantColumn?: string;
  categoryColumn?: string | null;
  amountConfig?: Record<string, unknown>;
}

export type ImportParserSourceType = 'activity-export' | 'statement';
export type ParsedImportSourceRole = 'activity' | 'statement-only';

export interface ParsedImportTransaction {
  sourceRowIndex: number;
  date: string;
  amountCents: number;
  description: string;
  institution?: string | null;
  account?: string | null;
  sourceRole: ParsedImportSourceRole;
  raw?: Record<string, unknown>;
}

export interface ParsedImportBalance {
  sourceRowIndex: number | null;
  date: string;
  balanceCents: number;
  account?: string | null;
  institution?: string | null;
  raw?: Record<string, unknown>;
}

export interface AppImportParseInput {
  fileName: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  text: string;
}

export interface AppImportParseResult {
  transactions: Array<ParsedImportTransaction | null>;
  balances: ParsedImportBalance[];
}

export interface AppImportParser {
  id: string;
  name: string;
  institution: string;
  sourceType: ImportParserSourceType;
  priority: number;
  matches(file: { fileName: string; headers: string[]; sample: string }): boolean;
  parse(input: AppImportParseInput): AppImportParseResult;
}

export interface ImportPreviewTransaction {
  importFileId: number;
  importRowId: number;
  sourceRowIndex: number;
  date: string;
  amountCents: number;
  amount: number;
  description: string;
  merchant: string;
  originalDescription: string;
  originalCategory: string | null;
  type: string;
  transactionKind?: string | null;
  status: string;
  notes: string;
  institution?: string | null;
  account?: string | null;
  sourceRole: ParsedImportSourceRole;
  raw?: Record<string, unknown>;
  categoryId: null;
  fingerprint?: string | null;
}

export interface CommitImportTransaction extends ImportPreviewTransaction {
  accountId: number;
  importBatchId: string;
  fingerprint: string;
}
