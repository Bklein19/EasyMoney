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
export type ParsedImportSourceRole = 'activity' | 'statement-only' | 'statement-summary';

export interface ParsedImportTransaction {
  sourceRowIndex: number;
  date: string;
  amountCents: number;
  description: string;
  institution?: string | null;
  account?: string | null;
  remoteAccountId?: string | null;
  accountHolder?: string | null;
  sourceRole: ParsedImportSourceRole;
  raw?: Record<string, unknown>;
}

export interface ParsedImportBalance {
  sourceRowIndex: number | null;
  date: string;
  balanceCents: number;
  account?: string | null;
  remoteAccountId?: string | null;
  institution?: string | null;
  accountHolder?: string | null;
  raw?: Record<string, unknown>;
}

export interface AppImportParseInput {
  fileName: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  text: string;
  filePath?: string;
  fileBytes?: Uint8Array;
}

export interface AppImportParseResult {
  transactions: Array<ParsedImportTransaction | null>;
  balances: ParsedImportBalance[];
  coveredFrom?: string | null;
  coveredTo?: string | null;
}

export interface AppImportParser {
  id: string;
  name: string;
  institution: string;
  sourceType: ImportParserSourceType;
  priority: number;
  matches(file: { fileName: string; headers: string[]; sample: string }): boolean;
  parse(input: AppImportParseInput): AppImportParseResult | Promise<AppImportParseResult>;
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
  accountHolder?: string | null;
  sourceRole: ParsedImportSourceRole;
  raw?: Record<string, unknown>;
  categoryId: null;
  fingerprint?: string | null;
  sourceAccountId?: number | null;
  resolvedAccountId?: number | null;
}

export type ImportAccountMappingResolution =
  | 'linked'
  | 'alias'
  | 'exact'
  | 'auto-create'
  | 'archived-match'
  | 'selected-fallback'
  | 'ambiguous'
  | 'unresolved';

export type ImportAccountMappingDecision =
  | { sourceAccountId: number; mode?: 'existing'; accountId: number | null }
  | { sourceAccountId: number; mode: 'auto'; accountId?: number | null }
  | { sourceAccountId: number; mode: 'unarchive'; accountId: number }
  | {
      sourceAccountId: number;
      mode: 'create';
      account: {
        name?: string | null;
        institution?: string | null;
        type?: string | null;
        currency?: string | null;
        accountHolder?: string | null;
      };
    };

export interface ImportAccountMapping {
  sourceAccountId: number;
  institution: string | null;
  sourceAccountName: string | null;
  sourceAccountHolder: string | null;
  resolvedAccountId: number | null;
  resolvedAccountStatus?: string | null;
  resolution: ImportAccountMappingResolution;
  transactionCount: number;
  balanceCount: number;
}

export interface CommitImportTransaction extends ImportPreviewTransaction {
  accountId: number;
  importBatchId: string;
  fingerprint: string;
}
