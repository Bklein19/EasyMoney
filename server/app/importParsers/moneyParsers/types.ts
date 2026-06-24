export type TransactionCategory = 'activity' | 'in-kind-transfer' | 'statement-summary';

export interface ParsedTransaction {
  id: string;
  date: string;
  amount_cents: number;
  description: string;
  account: string;
  institution: string;
  category: TransactionCategory;
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
  covered_from?: string;
  covered_to?: string;
}

export interface ParserMeta {
  id: string;
  institution: string;
  kind: 'activity-export' | 'statement';
  priority: number;
  matches(file: { filename: string; sample: string }): boolean;
}

export interface ParserModule {
  meta: ParserMeta;
  parse(filePath: string): Promise<ParseResult>;
}
