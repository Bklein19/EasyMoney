import { getDocumentProxy, extractText } from "unpdf";
import type { ParseResult, ParserMeta } from "./types.ts";
import { cents, makeTx } from "./_helpers";

export const meta: ParserMeta = {
  id: "robinhood-credit-card-statement-pdf",
  institution: "Robinhood",
  kind: "statement",
  priority: 50,
  matches: ({ filename, sample }) =>
    /\.pdf$/i.test(filename) &&
    /creditcards@robinhood\.com/i.test(sample) &&
    /Account Number:\s*(?:X{4}\s*){3}\d{4}/i.test(sample) &&
    /Statement Closing Date/i.test(sample) &&
    /TRANSACTIONS/i.test(sample),
};

const MONTHS = new Map([
  ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["may", 5], ["june", 6],
  ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
]);

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function closingDate(text: string) {
  const match = text.match(/Statement Closing Date\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (!match) throw new Error("Could not find Robinhood credit card statement closing date");
  const month = MONTHS.get(match[1]!.toLowerCase());
  if (!month) throw new Error(`Invalid Robinhood credit card statement month: ${match[1]}`);
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
}

function accountName(text: string) {
  const match = text.match(/Account Number:\s*(?:X{4}\s*){3}(\d{4})/i);
  if (!match) throw new Error("Could not find Robinhood credit card account number");
  return `Robinhood Gold Card - ${match[1]}`;
}

function transactionDate(month: string, day: string, coveredTo: string) {
  const coveredYear = Number(coveredTo.slice(0, 4));
  const coveredMonth = Number(coveredTo.slice(5, 7));
  const parsedMonth = Number(month);
  const year = parsedMonth > coveredMonth ? coveredYear - 1 : coveredYear;
  return `${year}-${String(parsedMonth).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
}

function parseActivity(text: string, account: string, coveredTo: string): ParseResult["transactions"] {
  const transactions: ParseResult["transactions"] = [];
  const rowPattern = /^(\d{2})\/(\d{2})\s+(\d{2})\/(\d{2})\s+([A-Z0-9]+)\s+(.+?)\s+([\d,]+\.\d{2}-?)$/;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeWhitespace(rawLine);
    const row = line.match(rowPattern);
    if (!row) continue;

    const parsedAmount = cents(row[7]!);
    const amount_cents = row[7]!.endsWith("-") ? -Math.abs(parsedAmount) : Math.abs(parsedAmount);
    if (amount_cents === 0) continue;

    transactions.push(makeTx({
      date: transactionDate(row[1]!, row[2]!, coveredTo),
      amount_cents,
      description: normalizeWhitespace(row[6]!),
      account,
      institution: "Robinhood",
      raw: {
        source: "robinhood-credit-card-statement",
        type: "credit-card-activity",
        transactionDate: `${row[1]}/${row[2]}`,
        postDate: `${row[3]}/${row[4]}`,
        reference: row[5],
      },
    }));
  }

  return transactions;
}

export function parseRobinhoodCreditCardStatementText(text: string): ParseResult {
  const account = accountName(text);
  const covered_to = closingDate(text);
  const balance = text.match(/(?:^|\n)=?\s*New Balance\s+\$([\d,]+\.\d{2})/im);
  if (!balance) throw new Error("Could not find Robinhood credit card new balance");
  const transactions = parseActivity(text, account, covered_to);
  const covered_from = transactions.map(transaction => transaction.date).sort()[0] || covered_to;

  return {
    transactions,
    balances: [{
      date: covered_to,
      account,
      institution: "Robinhood",
      balance_cents: -Math.abs(cents(balance[1]!)),
    }],
    covered_from,
    covered_to,
  };
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
  const { text } = await extractText(pdf);
  return parseRobinhoodCreditCardStatementText(text.join("\n"));
}
