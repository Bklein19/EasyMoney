export interface ParsedTransaction {
  id: string;
  date: string; // ISO 8601: YYYY-MM-DD
  amount_cents: number; // positive = credit, negative = debit
  description: string;
  account: string;
  institution: string;
  raw: Record<string, unknown>;
}

export interface ParsedBalance {
  date: string;
  account: string;
  institution: string;
  balance_cents: number;
}

export interface ParseResult {
  transactions: ParsedTransaction[];
  balances: ParsedBalance[];
  // Inclusive date range of data covered by this file. If omitted, inferred from
  // the min/max dates in transactions + balances by the importer before committing.
  covered_from?: string; // YYYY-MM-DD
  covered_to?: string;   // YYYY-MM-DD
}

// A committed parser module. Lives in parsers/<id>.ts, default-exports `parse`
// and named-exports `meta`. The registry (parsers/index.ts) is the single source
// of truth for which parser handles which file — replacing the old DB parsers table.
export interface ParserMeta {
  id: string;
  institution: string;
  // Source kind drives dedup priority. When two files cover the same (account, month),
  // transactions come from the higher-priority kind only. Balances always come from
  // statements. activity-export (full transaction history) outranks statement.
  kind: "activity-export" | "statement";
  // Higher wins. activity-export parsers should sit above statement parsers.
  priority: number;
  // Decides whether this parser handles a given raw file. `sample` is a short
  // text excerpt (first ~2KB, best-effort) for cases where the filename alone is
  // ambiguous (e.g. generic "statement-4.pdf"). Must be deterministic and mutually
  // exclusive across parsers — at most one parser matches any file.
  matches(file: { filename: string; sample: string }): boolean;
}

export interface ParserModule {
  meta: ParserMeta;
  parse(filePath: string): Promise<ParseResult>;
}

export interface Parser {
  id: string;
  institution: string;
  file_type: string;
  parse(filePath: string): Promise<ParseResult>;
}

export interface ValidationError {
  field: string;
  message: string;
  row?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}
