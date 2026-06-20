import { basename } from "path";
import type { ParseResult, ParserMeta } from "./types.ts";
import { cents, makeTx, pdfToText } from "./_helpers";

export const meta: ParserMeta = {
  id: "marcus-statement-pdf",
  institution: "Marcus",
  kind: "statement",
  priority: 50,
  matches: ({ filename, sample }) =>
    /^marcus-online-savings-\d{4}-\d{4}-\d{2}-\d{2}-statement\.pdf$/i.test(filename) ||
    (/Goldman Sachs Bank USA/.test(sample) && /ONLINE SAVINGS ACCOUNT STATEMENT/.test(sample)),
};

function cleanDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isoDate(monthRaw: string, dayRaw: string, yearRaw: string): string {
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  if (!month || !day || !year) throw new Error(`Invalid Marcus statement date: ${monthRaw}/${dayRaw}/${yearRaw}`);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function accountName(text: string, filePath: string): string {
  const filenameLast4 = basename(filePath).match(/^marcus-online-savings-(\d{4})-/i)?.[1];
  const textLast4 = text.match(/Account Number\s+(\d+)/)?.[1]?.slice(-4);
  const last4 = filenameLast4 ?? textLast4;
  if (!last4) throw new Error("Could not find Marcus account number");
  return `Online Savings - ${last4}`;
}

function statementPeriod(text: string): { covered_from: string; covered_to: string } {
  const period = text.match(/Statement Period\s+(\d{2})\/(\d{2})\/(\d{4})\s+to\s+(\d{2})\/(\d{2})\/(\d{4})/);
  if (!period) throw new Error("Could not find Marcus statement period");
  return {
    covered_from: isoDate(period[1]!, period[2]!, period[3]!),
    covered_to: isoDate(period[4]!, period[5]!, period[6]!),
  };
}

function parseActivity(text: string, account: string): ParseResult["transactions"] {
  const transactions: ParseResult["transactions"] = [];
  const lines = text.split(/\n/);
  const header = lines.find((line) => /^\s*Date\s+Description\s+Credits\s+Debits\s+Balance\s*$/.test(line));
  if (!header) throw new Error("Could not find Marcus account activity header");

  const creditCol = header.indexOf("Credits");
  const debitCol = header.indexOf("Debits");
  const balanceCol = header.indexOf("Balance");
  let inActivity = false;
  let current:
    | {
        date: string;
        description: string;
        amount_cents: number;
      }
    | undefined;

  const flush = () => {
    if (!current) return;
    transactions.push(
      makeTx({
        date: current.date,
        amount_cents: current.amount_cents,
        description: cleanDescription(current.description),
        account,
        institution: "Marcus",
        raw: { source: "marcus-statement", type: "online-savings-activity" },
      })
    );
    current = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");
    const trimmed = line.trim();

    if (/^Date\s+Description\s+Credits\s+Debits\s+Balance$/i.test(trimmed)) {
      inActivity = true;
      continue;
    }
    if (!inActivity) continue;
    if (/^©\d{4} Goldman Sachs Bank USA/i.test(trimmed) || /^STMTCMB100\b/.test(trimmed)) {
      flush();
      break;
    }

    const row = line.match(/^\s*(\d{2})\/(\d{2})\/(\d{4})\s+(.+)$/);
    if (row) {
      const date = isoDate(row[1]!, row[2]!, row[3]!);
      const restStart = line.indexOf(row[4]!);
      const rest = row[4]!;
      const moneyMatches = [...rest.matchAll(/\$[\d,]+\.\d{2}/g)];
      const description = cleanDescription(rest.slice(0, moneyMatches[0]?.index ?? rest.length));

      flush();
      if (/^(Beginning|Ending) Balance$/i.test(description)) continue;
      if (moneyMatches.length < 2) throw new Error(`Could not parse Marcus activity row: ${trimmed}`);

      const amountMatch = moneyMatches[0]!;
      const amountCol = restStart + amountMatch.index!;
      const amount = cents(amountMatch[0]);
      current = {
        date,
        description,
        amount_cents: amountCol >= debitCol - 2 ? -Math.abs(amount) : Math.abs(amount),
      };
      continue;
    }

    if (current && /^\s{8,}\S/.test(line) && !/^Page \d+/.test(trimmed)) {
      const cutAt = Math.min(...[creditCol, debitCol, balanceCol].filter((n) => n > 0 && n < line.length));
      current.description += ` ${line.slice(0, cutAt).trim()}`;
    }
  }

  flush();
  return transactions;
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const text = await pdfToText(filePath, true);
  const account = accountName(text, filePath);
  const { covered_from, covered_to } = statementPeriod(text);
  const balance = text.match(/Ending Balance\s+\$?([\d,]+\.\d{2})/);
  if (!balance) throw new Error("Could not find Marcus ending balance");

  return {
    transactions: parseActivity(text, account),
    balances: [
      {
        date: covered_to,
        account,
        institution: "Marcus",
        balance_cents: cents(balance[1]!),
      },
    ],
    covered_from,
    covered_to,
  };
}
