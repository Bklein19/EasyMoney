import { basename } from "path";
import type { ParseResult, ParserMeta } from "./types.ts";
import { cents, makeTx } from "./_helpers";

export const meta: ParserMeta = {
  id: "wells-fargo-activity-csv",
  institution: "Wells Fargo",
  kind: "activity-export",
  priority: 100,
  matches: ({ filename, sample }) =>
    /^wells-fargo-(checking|autograph-visa|platinum-card)-\d{4}-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/i.test(filename),
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
  if (!m || !d || !y) throw new Error(`Invalid Wells Fargo CSV date: ${value}`);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function normalizedHeader(value = ""): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isWellsFargoActivityHeader(row: string[]): boolean {
  const headers = row.map(normalizedHeader);
  return (
    headers[0] === "date" &&
    headers[1] === "description" &&
    headers[2] === "amount" &&
    (headers[3] === "check" || headers[3] === "checknumber") &&
    headers[4] === "status"
  );
}

function accountFromFilename(filePath: string): { account: string; liability: boolean } {
  const filename = basename(filePath).replace(/^[0-9a-f]{64}-/, "");
  const m = filename.match(/^wells-fargo-(checking|autograph-visa|platinum-card)-(\d{4})-/i);
  if (!m) throw new Error(`Could not infer Wells Fargo account from filename: ${filename}`);

  const slug = m[1]!.toLowerCase();
  const last4 = m[2]!;
  if (slug === "checking") return { account: `Checking - ${last4}`, liability: false };
  if (slug === "autograph-visa") return { account: `Autograph Visa - ${last4}`, liability: true };
  return { account: `Platinum Card - ${last4}`, liability: true };
}

function coveredRangeFromFilename(filePath: string): { covered_from?: string; covered_to?: string } {
  const filename = basename(filePath).replace(/^[0-9a-f]{64}-/, "");
  const m = filename.match(/-(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})\.csv$/i);
  return { covered_from: m?.[1], covered_to: m?.[2] };
}

function isLikelyPayment(description: string): boolean {
  return /\b(payment|pmt|autopay|auto pay|online transfer|thank you)\b/i.test(description);
}

function normalizeAmountCents(amountRaw: string, description: string, liability: boolean): number {
  const signedAmount = cents(amountRaw);
  if (!liability) return signedAmount;

  if (signedAmount > 0 && !isLikelyPayment(description)) {
    return -signedAmount;
  }

  return signedAmount;
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const rows = parseCsv(await Bun.file(filePath).text());
  const headerIndex = rows.findIndex(isWellsFargoActivityHeader);
  if (headerIndex === -1) throw new Error("Could not find Wells Fargo CSV transaction header");

  const { account, liability } = accountFromFilename(filePath);
  const transactions: ParseResult["transactions"] = [];

  for (const row of rows.slice(headerIndex + 1)) {
    const [dateRaw, descriptionRaw, amountRaw, checkNumberRaw, statusRaw] = row;
    if (!dateRaw || !descriptionRaw || !amountRaw) continue;
    if (statusRaw?.trim() && statusRaw.trim().toLowerCase() !== "posted") continue;

    const description = descriptionRaw.replace(/\s+/g, " ").trim();
    transactions.push(
      makeTx({
        date: isoDate(dateRaw),
        amount_cents: normalizeAmountCents(amountRaw, description, liability),
        description,
        account,
        institution: "Wells Fargo",
        raw: {
          source: "wells-fargo-csv",
          checkNumber: checkNumberRaw?.trim() || undefined,
          status: statusRaw?.trim() || undefined,
        },
      })
    );
  }

  const dates = transactions.map((tx) => tx.date).sort();
  const range = coveredRangeFromFilename(filePath);
  return {
    transactions,
    balances: [],
    covered_from: range.covered_from ?? dates[0],
    covered_to: range.covered_to ?? dates.at(-1),
  };
}
