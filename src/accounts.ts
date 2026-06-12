import { getDb } from "./db";

export type AccountType =
  | "checking"
  | "savings"
  | "brokerage"
  | "retirement"
  | "credit-card"
  | "loan"
  | "unknown";

export interface AccountWithAliases {
  id: number;
  name: string;
  institution: string;
  type: string;
  classification: string;
  tax_treatment: string;
  aliases: string[];
}

export function listAccountsWithAliases(): AccountWithAliases[] {
  const db = getDb();
  const accounts = db
    .query<Omit<AccountWithAliases, "aliases">, []>(
      "SELECT id, name, institution, type, classification, tax_treatment FROM accounts ORDER BY institution, name"
    )
    .all();
  const aliases = db
    .query<{ alias: string; account_id: number }, []>(
      "SELECT alias, account_id FROM account_aliases"
    )
    .all();
  return accounts.map((a) => ({
    ...a,
    aliases: aliases.filter((al) => al.account_id === a.id).map((al) => al.alias),
  }));
}

export function lookupAlias(institution: string, alias: string): number | null {
  const db = getDb();
  const row = db
    .query<{ account_id: number }, [string, string]>(
      "SELECT account_id FROM account_aliases WHERE alias = ? AND institution = ?"
    )
    .get(alias, institution);
  return row?.account_id ?? null;
}

export function createAlias(institution: string, alias: string, accountId: number): void {
  const db = getDb();
  const account = db
    .query<{ id: number }, [number]>("SELECT id FROM accounts WHERE id = ?")
    .get(accountId);
  if (!account) throw new Error(`Account ${accountId} does not exist`);
  db.run(
    "INSERT OR REPLACE INTO account_aliases (alias, institution, account_id) VALUES (?, ?, ?)",
    [alias, institution, accountId]
  );
}

export function createAccount(opts: {
  name: string;
  institution: string;
  type: AccountType;
  classification: "asset" | "liability";
  tax_treatment: "taxable" | "traditional" | "roth" | "hsa" | "none";
  alias?: string;
}): number {
  const db = getDb();
  db.run(
    "INSERT INTO accounts (name, institution, type, classification, tax_treatment) VALUES (?, ?, ?, ?, ?)",
    [opts.name, opts.institution, opts.type, opts.classification, opts.tax_treatment]
  );
  const id = (db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get())!.id;
  if (opts.alias) {
    createAlias(opts.institution, opts.alias, id);
  }
  return id;
}

// Resolve a parser-emitted (institution, account-string) pair to a canonical account id.
// The agent should have mapped every alias during import; this auto-create path is a
// safety net so a commit never fails on an unmapped account.
// Editable account metadata (the manual facts about an account). Only the fields
// the user controls — never the auto-derived balances. Unspecified fields are left
// unchanged. Column names are allow-listed so this can't be used to write arbitrary SQL.
export interface AccountEdit {
  name?: string;
  type?: AccountType;
  classification?: "asset" | "liability";
  tax_treatment?: "taxable" | "traditional" | "roth" | "hsa" | "none";
  flow_treatment?: "normal" | "contributions";
}

const EDITABLE_COLUMNS = new Set(["name", "type", "classification", "tax_treatment", "flow_treatment"]);

export function updateAccount(id: number, edit: AccountEdit): void {
  const db = getDb();
  const entries = Object.entries(edit).filter(([k, v]) => EDITABLE_COLUMNS.has(k) && v !== undefined);
  if (entries.length === 0) return;
  const setClause = entries.map(([k]) => `${k} = ?`).join(", ");
  const values = entries.map(([, v]) => v as string);
  db.run(`UPDATE accounts SET ${setClause} WHERE id = ?`, [...values, id]);
}

export function deleteAlias(institution: string, alias: string): void {
  getDb().run("DELETE FROM account_aliases WHERE alias = ? AND institution = ?", [alias, institution]);
}

export function resolveAccountId(institution: string, alias: string): number {
  const existing = lookupAlias(institution, alias);
  if (existing !== null) return existing;

  return createAccount({
    name: alias,
    institution,
    type: "unknown",
    classification: "asset",
    tax_treatment: "taxable",
    alias,
  });
}
