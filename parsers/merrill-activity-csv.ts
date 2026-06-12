import type { ParseResult, ParserMeta } from "../src/types";
import { cents, makeTx } from "./_helpers";

export const meta: ParserMeta = {
  id: "merrill-activity-csv",
  institution: "Merrill",
  kind: "activity-export",
  priority: 100,
  matches: ({ filename, sample }) =>
    /^merrill-activity-.*\.csv$/i.test(filename) ||
    /^SettledActivity_\d{6}_\d{6}\.csv$/i.test(filename) ||
    sample.startsWith(
      '"Trade Date","Settlement Date","Pending/Settled","Account Nickname","Account Registration","Account #"'
    ),
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

    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
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

function toIsoDate(value: string): string {
  const [m, d, y] = value.split("/").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function clean(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "--" ? "" : trimmed;
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const rows = parseCsv(await Bun.file(filePath).text());
  const header = rows.shift();
  if (!header) return { transactions: [], balances: [] };

  const index = new Map(header.map((name, i) => [name.trim(), i]));
  const get = (row: string[], name: string): string => clean(row[index.get(name) ?? -1]);

  const transactions: ParseResult["transactions"] = [];

  for (const row of rows) {
    const tradeDate = get(row, "Trade Date");
    const settlementDate = get(row, "Settlement Date") || tradeDate;
    const amount = get(row, "Amount ($)");
    if (!settlementDate || !amount) continue;

    const accountRegistration = get(row, "Account Registration");
    const accountNumber = get(row, "Account #");
    const account = [accountRegistration, accountNumber].filter(Boolean).join(" - ");
    const type = get(row, "Type");
    const description1 = get(row, "Description 1");
    const description2 = get(row, "Description 2");
    const symbol = get(row, "Symbol/CUSIP #");
    const description = [type, description1, description2, symbol].filter(Boolean).join(" | ");

    transactions.push(
      makeTx({
        date: toIsoDate(settlementDate),
        amount_cents: cents(amount),
        description,
        account,
        institution: "Merrill",
        raw: {
          tradeDate,
          settlementDate,
          pendingOrSettled: get(row, "Pending/Settled"),
          accountNickname: get(row, "Account Nickname"),
          accountRegistration,
          accountNumber,
          type,
          description1,
          description2,
          symbol,
          quantity: get(row, "Quantity"),
          price: get(row, "Price ($)"),
          amount,
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
