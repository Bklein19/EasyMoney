import type { ParseResult, ParserMeta } from "../src/types";
import { cents, makeTx } from "./_helpers";
import { getDocumentProxy, extractText } from "unpdf";

export const meta: ParserMeta = {
  id: "robinhood-statement-pdf",
  institution: "Robinhood",
  kind: "statement",
  priority: 50,
  matches: ({ filename, sample }) =>
    /^robinhood-\d+-\d{4}-\d{2}-\d{2}-statement\.pdf$/i.test(filename) ||
    /\b(Individual Investing Account Statement|Consolidated IRA Statement)-?\.pdf$/i.test(filename) ||
    (/\.pdf$/i.test(filename) &&
      /Robinhood/i.test(sample) &&
      /Account Summary/i.test(sample) &&
      /(Portfolio Value|Net Account Balance|Account #:)/i.test(sample)),
};

const ACTIVITY_ACTIONS = new Set(["ACATI", "ACH", "BTO", "INT", "MTCH", "STC", "STO", "XENT_CC", "Buy", "Sell"]);
const DEBIT_ACTIONS = new Set(["BTO", "Buy"]);
const SKIP_LINES = [
  /^Page of\d+ \d+$/,
  /^Account Activity$/,
  /^Description Symbol Acct Type Transaction Date Qty Price Debit Credit$/,
  /^Description Symbol Acct Type Trans Type Record Date Qty Price Debit Credit$/,
  /^Description Symbol Acct Type Trans Type Record Date Quantity Price Debit Credit$/,
  /^Total Funds Paid and Received\b/,
  /^CUSIP:\s*\S+$/,
  /^Portfolio Summary$/,
  /^Securities Held in Account\b/,
  /^Estimated Yield:/,
];

function mmddyyyyToIso(value: string) {
  const [month, day, year] = value.split("/").map(Number);
  if (!month || !day || !year) throw new Error(`Invalid Robinhood statement date: ${value}`);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateToIso(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return mmddyyyyToIso(value);
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function accountFromLine(line: string, nextLine = "") {
  const account = line.match(/^([A-Za-z][A-Za-z ]*?)\s+Account #:\s*(\d+)/i);
  if (!account) return null;
  const label = normalizeWhitespace(account[1]!);
  const explicitAccountType = /^(traditional ira|roth ira)$/i.test(nextLine)
    ? normalizeWhitespace(nextLine)
    : "";
  const normalizedLabel = (explicitAccountType || label).toLowerCase();
  const accountTypeLabel = normalizedLabel.includes("traditional ira")
    ? "Traditional IRA"
    : normalizedLabel.includes("roth ira")
      ? "Roth IRA"
      : normalizedLabel.includes("ira")
        ? label
        : "Individual";
  return `Robinhood ${accountTypeLabel} - ${account[2]!.slice(-4)}`;
}

function firstAccountName(text: string) {
  const lines = text.split(/\r?\n/).map(normalizeWhitespace);
  for (let index = 0; index < lines.length; index += 1) {
    const account = accountFromLine(lines[index]!, lines[index + 1] || "");
    if (account) return account;
  }

  throw new Error("Could not find Robinhood account number");
}

function statementPeriod(text: string) {
  const period = text.match(/(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})\s+to\s+(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/);
  if (!period) throw new Error("Could not find Robinhood statement period");
  return {
    covered_from: dateToIso(period[1]!),
    covered_to: dateToIso(period[2]!),
  };
}

function closingPortfolioValue(text: string) {
  const summary = text.match(/Portfolio Value\s+\$[\d,]+\.\d{2}\s+(\$[\d,]+\.\d{2})/);
  if (!summary) throw new Error("Could not find Robinhood closing portfolio value");
  return cents(summary[1]!);
}

function portfolioValueFromLine(line: string) {
  const summary = line.match(/^Portfolio Value\s+\$[\d,]+\.\d{2}\s+(\$[\d,]+\.\d{2})/);
  return summary ? cents(summary[1]!) : null;
}

function splitDescriptionAndSymbol(left: string, pendingDescription: string | null) {
  const normalized = normalizeWhitespace(left);
  if (/^CUSIP:\s*\S+\s+\S+$/.test(normalized)) {
    const parts = normalized.split(/\s+/);
    return {
      description: pendingDescription || normalized,
      symbol: parts.at(-1) || null,
    };
  }

  const parts = normalized.split(/\s+/);
  const last = parts.at(-1) || "";
  if (/^[A-Z][A-Z0-9._-]{0,7}$/.test(last) && parts.length === 1) {
    return {
      description: pendingDescription || normalized,
      symbol: last,
    };
  }

  if (/^[A-Z][A-Z0-9._-]{0,7}$/.test(last) && parts.length > 1) {
    return {
      description: parts.slice(0, -1).join(" "),
      symbol: last,
    };
  }

  return {
    description: normalized,
    symbol: null,
  };
}

function parseActivityLine(line: string, pendingDescription: string | null) {
  const match = line.match(/^(?<left>.+?)\s+(?<accountType>Cash|CASH|Margin|MARGIN|Sweep|SWEEP)\s+(?<action>[A-Z_]+|Buy|Sell)\s+(?<date>\d{1,2}\/\d{1,2}\/\d{4})(?<rest>.*)$/);
  if (!match?.groups) return null;

  const action = match.groups.action;
  if (!ACTIVITY_ACTIONS.has(action)) return null;

  const moneyMatches = [...match.groups.rest.matchAll(/\$[\d,]+\.\d{2}/g)].map(item => item[0]);
  if (!moneyMatches.length) return null;

  const amount = cents(moneyMatches.at(-1)!);
  const signedAmount = DEBIT_ACTIONS.has(action) ? -Math.abs(amount) : Math.abs(amount);
  const { description, symbol } = splitDescriptionAndSymbol(match.groups.left, pendingDescription);
  const price = moneyMatches.length > 1 ? moneyMatches.at(-2) || null : null;
  const quantity = match.groups.rest
    .replace(/\$[\d,]+\.\d{2,5}/g, "")
    .trim()
    .split(/\s+/)
    .find(token => /^-?\d+(?:\.\d+)?$/.test(token)) || null;

  return {
    date: mmddyyyyToIso(match.groups.date),
    amount_cents: signedAmount,
    description: `${action} ${description}`,
    raw: {
      source: "robinhood-statement",
      action,
      symbol,
      accountType: normalizeWhitespace(match.groups.accountType).toLowerCase().replace(/^\w/, value => value.toUpperCase()),
      quantity,
      price,
    },
  };
}

export function parseRobinhoodStatementText(text: string): ParseResult {
  const fallbackAccount = firstAccountName(text);
  const { covered_from, covered_to } = statementPeriod(text);
  const transactions: ParseResult["transactions"] = [];
  const balancesByAccount = new Map<string, number>();
  let currentAccount = fallbackAccount;
  let pendingDescription: string | null = null;
  const lines = text.split(/\r?\n/).map(normalizeWhitespace);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line) continue;

    const account = accountFromLine(line, lines[index + 1] || "");
    if (account) {
      currentAccount = account;
      pendingDescription = null;
      continue;
    }

    const balance = portfolioValueFromLine(line);
    if (balance !== null) {
      balancesByAccount.set(currentAccount, balance);
      pendingDescription = null;
      continue;
    }

    if (SKIP_LINES.some(pattern => pattern.test(line))) continue;

    const activity = parseActivityLine(line, pendingDescription);
    if (activity) {
      transactions.push(makeTx({
        ...activity,
        account: currentAccount,
        institution: "Robinhood",
      }));
      pendingDescription = null;
      continue;
    }

    if (!line.includes("$") && !/\b(Account Summary|Portfolio Allocation|Income and Expense Summary|Important Information)\b/.test(line)) {
      pendingDescription = line;
    }
  }

  return {
    transactions,
    balances: balancesByAccount.size
      ? [...balancesByAccount.entries()].map(([account, balance_cents]) => ({
          date: covered_to,
          account,
          institution: "Robinhood",
          balance_cents,
        }))
      : [{
          date: covered_to,
          account: fallbackAccount,
          institution: "Robinhood",
          balance_cents: closingPortfolioValue(text),
        }],
    covered_from,
    covered_to,
  };
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
  const { text } = await extractText(pdf);
  return parseRobinhoodStatementText(text.join("\n"));
}
