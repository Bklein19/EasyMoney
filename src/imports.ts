import { getDb } from "./db";

export interface ImportRecord {
  id: number;
  filename: string;
  status: string;
  parser_id: string | null;
  covered_from: string | null;
  covered_to: string | null;
  imported_at: string;
  transactions_count: number;
  balances_count: number;
  accounts: string[];
}

export function getImportList(): ImportRecord[] {
  const db = getDb();

  const rows = db
    .query<
      {
        id: number;
        filename: string;
        status: string;
        parser_id: string | null;
        covered_from: string | null;
        covered_to: string | null;
        imported_at: string;
      },
      []
    >(
      `SELECT id, filename, status, parser_id, covered_from, covered_to, imported_at
       FROM import_files ORDER BY imported_at DESC`
    )
    .all();

  return rows.map((row) => {
    const txCount = (
      db
        .query<{ c: number }, [number]>(
          "SELECT COUNT(*) as c FROM transactions WHERE import_file_id = ?"
        )
        .get(row.id) ?? { c: 0 }
    ).c;

    const balCount = (
      db
        .query<{ c: number }, [number]>(
          "SELECT COUNT(*) as c FROM account_balances WHERE import_file_id = ?"
        )
        .get(row.id) ?? { c: 0 }
    ).c;

    const accounts = db
      .query<{ name: string; institution: string }, [number]>(
        `SELECT DISTINCT a.name, a.institution
         FROM accounts a
         WHERE a.id IN (
           SELECT DISTINCT account_id FROM transactions WHERE import_file_id = ? AND account_id IS NOT NULL
           UNION
           SELECT DISTINCT account_id FROM account_balances WHERE import_file_id = ? AND account_id IS NOT NULL
         )`
      )
      .all(row.id, row.id)
      .map((a) => `${a.institution} ${a.name}`);

    return {
      ...row,
      transactions_count: txCount,
      balances_count: balCount,
      accounts,
    };
  });
}
