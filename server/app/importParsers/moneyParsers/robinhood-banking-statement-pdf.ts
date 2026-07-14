import { getDocumentProxy, extractText } from "unpdf";
import type { ParseResult, ParserMeta } from "./types.ts";
import { cents, makeTx } from "./_helpers";

export const meta: ParserMeta = {
  id: "robinhood-banking-statement-pdf",
  institution: "Robinhood",
  kind: "statement",
  priority: 50,
  matches: ({ filename, sample }) =>
    /\.pdf$/i.test(filename) &&
    /Robinhood Banking/i.test(sample) &&
    /(?:Joint )?Checking \d{4}/i.test(sample) &&
    /Account Activity/i.test(sample),
};

const MONTHS = new Map([
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["may", 5], ["jun", 6],
  ["jul", 7], ["aug", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
]);

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function shortDateToIso(value: string) {
  const [month, day, shortYear] = value.split("/").map(Number);
  if (!month || !day || shortYear === undefined) {
    throw new Error(`Invalid Robinhood Banking statement date: ${value}`);
  }
  const year = shortYear < 100 ? 2000 + shortYear : shortYear;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function longDateToIso(monthName: string, day: string, year: string) {
  const month = MONTHS.get(monthName.toLowerCase().slice(0, 3));
  if (!month) throw new Error(`Invalid Robinhood Banking statement month: ${monthName}`);
  return `${year}-${String(month).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
}

function accountName(text: string) {
  const match = text.match(/\b((?:Joint )?Checking)\s+(\d{4})\b/i);
  if (!match) throw new Error("Could not find Robinhood Banking account number");
  const type = /^joint/i.test(match[1]!) ? "Joint Checking" : "Checking";
  return `Robinhood ${type} - ${match[2]}`;
}

function statementBalance(text: string) {
  const match = text.match(/Total Ending Balance \(([A-Za-z]{3,9}) (\d{1,2}), (\d{4})\)\s+\$([\d,]+\.\d{2})/i);
  if (!match) throw new Error("Could not find Robinhood Banking ending balance");
  return {
    date: longDateToIso(match[1]!, match[2]!, match[3]!),
    balance_cents: cents(match[4]!),
  };
}

function parseActivity(text: string, account: string): ParseResult["transactions"] {
  const transactions: ParseResult["transactions"] = [];
  const occurrenceByTransactionId = new Map<string, number>();
  let pending: { date: string; description: string } | null = null;

  const addTransaction = (date: string, description: string, category: string, amount: string) => {
    const parsedAmount = cents(amount);
    const amount_cents = /^debit$/i.test(category) ? -Math.abs(parsedAmount) : Math.abs(parsedAmount);
    const transaction = makeTx({
      date: shortDateToIso(date),
      amount_cents,
      description: normalizeWhitespace(description),
      account,
      institution: "Robinhood",
      raw: {
        source: "robinhood-banking-statement",
        category,
      },
    });
    const occurrenceIndex = occurrenceByTransactionId.get(transaction.id) ?? 0;
    occurrenceByTransactionId.set(transaction.id, occurrenceIndex + 1);
    transaction.id = `${transaction.id}:${occurrenceIndex}`;
    transactions.push(transaction);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeWhitespace(rawLine);
    if (!line) continue;

    const complete = line.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+?)\s+(Credit|Debit)\s+([+-]?\$[\d,]+\.\d{2})\s+\$[\d,]+\.\d{2}$/i);
    if (complete) {
      pending = null;
      addTransaction(complete[1]!, complete[2]!, complete[3]!, complete[4]!);
      continue;
    }

    const start = line.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+)$/);
    if (start) {
      const description = start[2]!;
      pending = /^(Beginning|Ending) Balance\b/i.test(description)
        ? null
        : { date: start[1]!, description };
      continue;
    }

    if (pending) {
      const continuation = line.match(/^(.+?)\s+(Credit|Debit)\s+([+-]?\$[\d,]+\.\d{2})\s+\$[\d,]+\.\d{2}$/i);
      if (continuation) {
        addTransaction(
          pending.date,
          `${pending.description} ${continuation[1]}`,
          continuation[2]!,
          continuation[3]!
        );
        pending = null;
      }
    }
  }

  return transactions;
}

export function parseRobinhoodBankingStatementText(text: string): ParseResult {
  const account = accountName(text);
  const balance = statementBalance(text);
  const transactions = parseActivity(text, account);
  const covered_from = transactions.map(transaction => transaction.date).sort()[0] || balance.date;

  return {
    transactions,
    balances: [{
      date: balance.date,
      account,
      institution: "Robinhood",
      balance_cents: balance.balance_cents,
    }],
    covered_from,
    covered_to: balance.date,
  };
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
  const { text } = await extractText(pdf);
  return parseRobinhoodBankingStatementText(text.join("\n"));
}
