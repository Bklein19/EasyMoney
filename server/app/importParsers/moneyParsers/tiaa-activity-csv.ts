import type { ParseResult, ParserMeta } from "./types.ts";
import { cents, makeTx } from "./_helpers";

export const meta: ParserMeta = {
  id: "tiaa-activity-csv",
  institution: "TIAA",
  kind: "activity-export",
  priority: 100,
  matches: ({ filename, sample }) =>
    /^tiaa-retirement-annuity-(?:current-year-)?(?:\d{4}|Tiaa-Cref\d{8}).*\.csv$/i.test(filename) ||
    sample.startsWith("Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission"),
};

const ACCOUNT = "Retirement Annuity";

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
  if (!m || !d || !y) throw new Error(`Invalid TIAA CSV date: ${value}`);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const rows = parseCsv(await Bun.file(filePath).text());
  const header = rows.shift();
  if (!header) return { transactions: [], balances: [] };

  const expected = ["Date", "AccountId", "Action", "Security", "Price", "Quantity", "Amount"];
  for (let i = 0; i < expected.length; i++) {
    if (header[i] !== expected[i]) throw new Error(`Unexpected TIAA CSV header: ${header.join(",")}`);
  }

  const index = new Map(header.map((name, i) => [name.trim(), i]));
  const get = (row: string[], name: string): string => clean(row[index.get(name) ?? -1]);
  const transactions: ParseResult["transactions"] = [];

  for (const row of rows) {
    const dateRaw = get(row, "Date");
    const amount = get(row, "Amount");
    if (!dateRaw || !amount) continue;

    const action = get(row, "Action");
    const security = get(row, "Security");
    const description = [action, security].filter(Boolean).join(" | ");

    transactions.push(
      makeTx({
        date: isoDate(dateRaw),
        amount_cents: cents(amount),
        description,
        account: ACCOUNT,
        institution: "TIAA",
        raw: {
          source: "tiaa-csv",
          accountId: get(row, "AccountId"),
          action,
          security,
          price: get(row, "Price"),
          quantity: get(row, "Quantity"),
          amount,
          text: get(row, "Text"),
          memo: get(row, "Memo"),
          commission: get(row, "Commission"),
        },
      })
    );
  }

  const dates = transactions.map((tx) => tx.date).sort();
  return {
    transactions,
    balances: [],
    covered_from: dates[0],
    covered_to: dates.at(-1),
  };
}
