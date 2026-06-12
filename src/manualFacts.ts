// Durable export/restore of the MANUAL FACTS — the inputs that rebuild() cannot
// regenerate from raw files: account records (name/type/classification/tax_treatment/
// flow_treatment), the alias→account mapping, and manual balance overrides.
//
// The JSON file is the durable backup. It's written automatically after every manual-
// fact mutation and is meant to be committed to git, so a dropped DB (or a fat-finger
// delete the in-session undo didn't catch) is always recoverable from disk + history.
// Output is canonically ordered so the file diffs cleanly.

import { getDb } from "./db";
import { join } from "path";

export const MANUAL_FACTS_PATH = join(import.meta.dir, "../data/manual-facts.json");

interface ManualFacts {
  // Schema version, so a future format change can be migrated rather than misread.
  version: 1;
  accounts: Array<{
    name: string;
    institution: string;
    type: string;
    classification: string;
    tax_treatment: string;
    flow_treatment: string;
  }>;
  aliases: Array<{ institution: string; alias: string; account: string }>; // account = "institution::name"
  manual_balances: Array<{ account: string; date: string; balance_cents: number; note: string | null }>;
}

const acctRef = (institution: string, name: string) => `${institution}::${name}`;

export function exportManualFacts(): ManualFacts {
  const db = getDb();
  const accountsRaw = db
    .query<{ id: number; name: string; institution: string; type: string; classification: string; tax_treatment: string; flow_treatment: string }, []>(
      "SELECT id, name, institution, type, classification, tax_treatment, flow_treatment FROM accounts"
    )
    .all();
  const idToRef = new Map(accountsRaw.map((a) => [a.id, acctRef(a.institution, a.name)]));

  const accounts = accountsRaw
    .map(({ name, institution, type, classification, tax_treatment, flow_treatment }) => ({
      name, institution, type, classification, tax_treatment, flow_treatment,
    }))
    .sort((a, b) => acctRef(a.institution, a.name).localeCompare(acctRef(b.institution, b.name)));

  const aliases = db
    .query<{ institution: string; alias: string; account_id: number }, []>(
      "SELECT institution, alias, account_id FROM account_aliases"
    )
    .all()
    .map((r) => ({ institution: r.institution, alias: r.alias, account: idToRef.get(r.account_id) ?? `#${r.account_id}` }))
    .sort((a, b) => `${a.account}\0${a.alias}`.localeCompare(`${b.account}\0${b.alias}`));

  const manual_balances = db
    .query<{ account_id: number; date: string; balance_cents: number; note: string | null }, []>(
      "SELECT account_id, date, balance_cents, note FROM manual_balances"
    )
    .all()
    .map((r) => ({ account: idToRef.get(r.account_id) ?? `#${r.account_id}`, date: r.date, balance_cents: r.balance_cents, note: r.note }))
    .sort((a, b) => `${a.account}\0${a.date}`.localeCompare(`${b.account}\0${b.date}`));

  return { version: 1, accounts, aliases, manual_balances };
}

// Write the manual-facts JSON to disk. Called after every manual-fact mutation.
// Fire-and-forget safe: failures are logged but never break the mutation.
export async function saveManualFacts(): Promise<void> {
  try {
    const facts = exportManualFacts();
    await Bun.write(MANUAL_FACTS_PATH, JSON.stringify(facts, null, 2) + "\n");
  } catch (err) {
    console.error("Failed to write manual-facts.json:", err);
  }
}

// Restore manual facts from the JSON file into the DB (idempotent upsert). Used to
// rebuild the manual-facts tables on a fresh/dropped DB. Does NOT delete facts that
// exist in the DB but not the file — it's additive, so a partial file can't wipe data.
export async function restoreManualFacts(path = MANUAL_FACTS_PATH): Promise<{ accounts: number; aliases: number; balances: number }> {
  const facts = JSON.parse(await Bun.file(path).text()) as ManualFacts;
  if (facts.version !== 1) throw new Error(`Unsupported manual-facts version: ${facts.version}`);
  const db = getDb();

  const refToId = new Map<string, number>();
  db.transaction(() => {
    for (const a of facts.accounts) {
      db.run(
        `INSERT INTO accounts (name, institution, type, classification, tax_treatment, flow_treatment)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name, institution) DO UPDATE SET
           type = excluded.type, classification = excluded.classification,
           tax_treatment = excluded.tax_treatment, flow_treatment = excluded.flow_treatment`,
        [a.name, a.institution, a.type, a.classification, a.tax_treatment, a.flow_treatment]
      );
    }
    for (const a of db.query<{ id: number; name: string; institution: string }, []>("SELECT id, name, institution FROM accounts").all()) {
      refToId.set(acctRef(a.institution, a.name), a.id);
    }
    for (const al of facts.aliases) {
      const id = refToId.get(al.account);
      if (id === undefined) continue;
      db.run("INSERT OR REPLACE INTO account_aliases (alias, institution, account_id) VALUES (?, ?, ?)", [al.alias, al.institution, id]);
    }
    for (const b of facts.manual_balances) {
      const id = refToId.get(b.account);
      if (id === undefined) continue;
      db.run("INSERT OR REPLACE INTO manual_balances (account_id, date, balance_cents, note) VALUES (?, ?, ?, ?)", [id, b.date, b.balance_cents, b.note]);
    }
  })();

  return { accounts: facts.accounts.length, aliases: facts.aliases.length, balances: facts.manual_balances.length };
}

// CLI: `bun src/manualFacts.ts export` | `bun src/manualFacts.ts restore`
if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "restore") {
    const r = await restoreManualFacts();
    console.log(`restored ${r.accounts} accounts, ${r.aliases} aliases, ${r.balances} manual balances`);
  } else {
    await saveManualFacts();
    console.log(`wrote ${MANUAL_FACTS_PATH}`);
  }
}
