import { basename } from "node:path";
import type { ParseResult, ParserMeta } from "./types.ts";
import { cents, makeTx } from "./_helpers";

export const meta: ParserMeta = {
  id: "bofa-activity-csv",
  institution: "Bank of America",
  kind: "activity-export",
  priority: 100,
  matches: ({ filename, sample }) =>
    /^bofa-(checking|savings)-\d{4}-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/i.test(filename) ||
    (sample.startsWith("Description,,Summary Amt.") && /Date,Description,Amount,Running Bal\./.test(sample)),
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (quoted) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

function isoDate(value: string): string {
  const [m, d, y] = value.split("/").map(Number);
  if (!m || !d || !y) throw new Error(`Invalid BofA CSV date: ${value}`);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function accountFromFilename(filePath: string): string {
  const filename = basename(filePath);
  const withLast4 = filename.match(/^bofa-(checking|savings)-(\d{4})-\d{4}-\d{2}-\d{2}-to-/i);
  if (withLast4) {
    return withLast4[1]!.toLowerCase() === "checking"
      ? `Adv Plus Banking - ${withLast4[2]}`
      : `Advantage Savings - ${withLast4[2]}`;
  }
  if (/^bofa-(checking|savings)-\d{4}-\d{2}-\d{2}-to-/i.test(filename)) return "Selected account";
  throw new Error(`Could not infer BofA account from filename: ${filename}`);
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const rows = parseCsv(await Bun.file(filePath).text());
  const headerIndex = rows.findIndex((row) => row[0] === "Date" && row[1] === "Description");
  if (headerIndex === -1) throw new Error("Could not find BofA CSV transaction header");

  const account = accountFromFilename(filePath);
  const transactions: ParseResult["transactions"] = [];
  const balances: ParseResult["balances"] = [];

  for (const row of rows.slice(headerIndex + 1)) {
    const [dateRaw, descriptionRaw, amountRaw, runningBalanceRaw] = row;
    if (!dateRaw || !descriptionRaw) continue;
    const date = isoDate(dateRaw);
    const description = descriptionRaw.trim();

    if (amountRaw?.trim()) {
      transactions.push(
        makeTx({
          date,
          amount_cents: cents(amountRaw),
          description,
          account,
          institution: "Bank of America",
          raw: { source: "bofa-csv", runningBalance: runningBalanceRaw ?? "" },
        })
      );
    }

    if (runningBalanceRaw?.trim()) {
      balances.push({
        date,
        account,
        institution: "Bank of America",
        balance_cents: cents(runningBalanceRaw),
      });
    }
  }

  const dates = [...transactions.map((tx) => tx.date), ...balances.map((b) => b.date)].sort();
  return {
    transactions,
    balances,
    covered_from: dates[0],
    covered_to: dates.at(-1),
  };
}
