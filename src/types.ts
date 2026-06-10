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
