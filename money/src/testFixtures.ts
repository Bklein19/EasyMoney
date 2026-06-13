import { getDb } from "./db";

export function seedReportFixture(): void {
  const db = getDb();

  db.transaction(() => {
    for (const account of [
      [9001, "Fixture Brokerage", "Fixture Bank", "brokerage"],
      [9002, "Fixture Roth", "Fixture Bank", "retirement"],
      [9003, "Fixture Checking", "Fixture Bank", "checking"],
    ] as const) {
      db.run(
        `INSERT OR IGNORE INTO accounts
          (id, name, institution, type, classification, tax_treatment, flow_treatment)
         VALUES (?, ?, ?, ?, 'asset', 'taxable', 'normal')`,
        account
      );
      db.run(
        "INSERT OR IGNORE INTO account_aliases (alias, institution, account_id) VALUES (?, ?, ?)",
        [account[1], account[2], account[0]]
      );
    }

    for (const balance of [
      [9001, "2026-01-31", 1_000_000],
      [9001, "2026-02-28", 2_000_000],
      [9002, "2026-03-31", 1_000_000],
      [9003, "2026-03-31", 100_000],
    ] as const) {
      db.run(
        `INSERT OR IGNORE INTO manual_balances
          (account_id, date, balance_cents, note)
         VALUES (?, ?, ?, 'sanitized test fixture')`,
        balance
      );
    }

    for (const tx of [
      ["fixture-transfer-out", "2026-03-02", -1_000_000, "Transfer out to Roth", "Fixture Brokerage", "Fixture Bank", 9001],
      ["fixture-transfer-in", "2026-03-03", 1_000_000, "Transfer in from brokerage", "Fixture Roth", "Fixture Bank", 9002],
      ["fixture-interest", "2026-03-15", 10_000, "Interest Paid", "Fixture Checking", "Fixture Bank", 9003],
    ] as const) {
      db.run(
        `INSERT OR IGNORE INTO transactions
          (id, import_file_id, date, amount_cents, description, account, institution, account_id, raw)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, '{}')`,
        tx
      );
    }
  })();
}
