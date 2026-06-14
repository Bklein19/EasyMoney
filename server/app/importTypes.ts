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

export interface ParsedImportRecord {
  sourceRowIndex: number;
  date: string;
  amount: number;
  description: string;
  merchant: string;
  originalDescription: string;
  originalCategory: string | null;
  type: string;
  transactionKind?: string | null;
  status: string;
  notes: string;
}

export interface AppImportParserMeta {
  id: string;
  name: string;
  institution: string;
  matches(file: { fileName: string; headers: string[]; sample: string }): boolean;
}

export interface AppImportParseInput {
  fileName: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  text: string;
}

export interface AppImportParseResult {
  records: Array<ParsedImportRecord | null>;
}

export interface AppImportParser {
  meta: AppImportParserMeta;
  parse(input: AppImportParseInput): AppImportParseResult;
}

export interface ImportPreviewTransaction extends ParsedImportRecord {
  importFileId: number;
  importRowId: number;
  categoryId: null;
  fingerprint?: string | null;
}

export interface CommitImportTransaction extends ImportPreviewTransaction {
  accountId: number;
  importBatchId: string;
  fingerprint: string;
}
