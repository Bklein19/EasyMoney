import { getDb } from "./db";

// Resolve a parser-emitted (institution, account-string) pair to a canonical account id.
// Unknown aliases auto-create an account with type 'unknown' for later classification.
export function resolveAccountId(institution: string, alias: string): number {
  const db = getDb();

  const existing = db
    .query<{ account_id: number }, [string, string]>(
      "SELECT account_id FROM account_aliases WHERE alias = ? AND institution = ?"
    )
    .get(alias, institution);
  if (existing) return existing.account_id;

  db.run("INSERT OR IGNORE INTO accounts (name, institution) VALUES (?, ?)", [alias, institution]);
  const accountId = (db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM accounts WHERE name = ? AND institution = ?"
    )
    .get(alias, institution))!.id;

  db.run(
    "INSERT INTO account_aliases (alias, institution, account_id) VALUES (?, ?, ?)",
    [alias, institution, accountId]
  );

  return accountId;
}
