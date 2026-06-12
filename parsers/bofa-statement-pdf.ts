import { basename } from "path";
import type { ParseResult, ParserMeta } from "../src/types";
import { cents, pdfToText } from "./_helpers";

export const meta: ParserMeta = {
  id: "bofa-statement-pdf",
  institution: "Bank of America",
  kind: "statement",
  priority: 50,
  matches: ({ filename, sample }) =>
    /^bofa-(checking|savings|credit-card)-\d{4}-\d{4}-[a-z]+-statement\.pdf$/i.test(filename) ||
    (/Bank of America/.test(sample) &&
      (/Your Adv Plus Banking/.test(sample) ||
        /Your Bank of America Advantage Savings/.test(sample) ||
        /Visa Signature/.test(sample) ||
        (/Payment Information/.test(sample) && /New Balance Total/.test(sample)))),
};

const MONTHS = new Map([
  ["january", 1],
  ["february", 2],
  ["march", 3],
  ["april", 4],
  ["may", 5],
  ["june", 6],
  ["july", 7],
  ["august", 8],
  ["september", 9],
  ["october", 10],
  ["november", 11],
  ["december", 12],
]);

function isoDate(monthName: string, dayRaw: string, yearRaw: string): string {
  const month = MONTHS.get(monthName.toLowerCase());
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  if (!month || !day || !year) throw new Error(`Invalid BofA statement date: ${monthName} ${dayRaw}, ${yearRaw}`);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function accountLast4(text: string): string {
  const m = text.match(/Account\s*(?:number|Number|#):?\s*(?:\d{4}\s+)*(\d{4})/);
  if (!m) throw new Error("Could not find BofA account number");
  return m[1]!;
}

function filenameLast4(filePath: string): string | undefined {
  return basename(filePath).match(/^bofa-(?:checking|savings|credit-card)-(\d{4})-/i)?.[1];
}

function filenameDepositType(filePath: string): "checking" | "savings" | undefined {
  return basename(filePath).match(/^bofa-(checking|savings)-\d{4}-/i)?.[1]?.toLowerCase() as
    | "checking"
    | "savings"
    | undefined;
}

function parseDeposit(text: string, filePath: string): ParseResult {
  const last4 = accountLast4(text);
  const type = filenameDepositType(filePath);
  const isSavings = type === "savings" || (!type && /Your Bank of America Advantage Savings/.test(text));
  const account = isSavings ? `Advantage Savings - ${last4}` : `Adv Plus Banking - ${last4}`;

  const period =
    text.match(/for ([A-Za-z]+) (\d{1,2}), (\d{4}) to ([A-Za-z]+) (\d{1,2}), (\d{4})/) ||
    text.match(/Account # [\d\s]+ ! ([A-Za-z]+) (\d{1,2}), (\d{4}) to ([A-Za-z]+) (\d{1,2}), (\d{4})/);
  if (!period) throw new Error("Could not find BofA deposit statement period");

  const covered_from = isoDate(period[1]!, period[2]!, period[3]!);
  const covered_to = isoDate(period[4]!, period[5]!, period[6]!);
  const balance = text.match(/Ending balance on [A-Za-z]+ \d{1,2}, \d{4}\s+\$?([\d,]+\.\d{2})/);
  if (!balance) throw new Error("Could not find BofA deposit ending balance");

  return {
    transactions: [],
    balances: [
      {
        date: covered_to,
        account,
        institution: "Bank of America",
        balance_cents: cents(balance[1]!),
      },
    ],
    covered_from,
    covered_to,
  };
}

function parseCreditCard(text: string, filePath: string): ParseResult {
  const last4 = filenameLast4(filePath) ?? accountLast4(text);
  const account = `Customized Cash Rewards Visa Signature - ${last4}`;

  const period =
    text.match(/Account# [\d\s]+(?:\d{4})\s+([A-Za-z]+) (\d{1,2}) - ([A-Za-z]+) (\d{1,2}), (\d{4})/) ||
    text.match(/([A-Za-z]+) (\d{1,2}) - ([A-Za-z]+) (\d{1,2}), (\d{4})/);
  const closingDate = text.match(/Statement Closing Date\s+(\d{2})\/(\d{2})\/(\d{4})/);
  if (!period && !closingDate) throw new Error("Could not find BofA credit card statement date");

  let covered_from: string | undefined;
  let covered_to: string;
  if (period) {
    const endYear = Number(period[5]!);
    const startMonth = MONTHS.get(period[1]!.toLowerCase())!;
    const endMonth = MONTHS.get(period[3]!.toLowerCase())!;
    const startYear = startMonth > endMonth ? endYear - 1 : endYear;
    covered_from = isoDate(period[1]!, period[2]!, String(startYear));
    covered_to = isoDate(period[3]!, period[4]!, period[5]!);
  } else {
    covered_to = `${closingDate![3]}-${closingDate![1]}-${closingDate![2]}`;
    covered_from = covered_to;
  }

  const balance =
    text.match(/New Balance Total\s+\$?([\d,]+\.\d{2})/) ||
    text.match(/New Balance Total\s+Current Payment Due[\s\S]{0,120}?\$?([\d,]+\.\d{2})/);
  if (!balance) throw new Error("Could not find BofA credit card new balance");

  return {
    transactions: [],
    balances: [
      {
        date: covered_to,
        account,
        institution: "Bank of America",
        balance_cents: -Math.abs(cents(balance[1]!)),
      },
    ],
    covered_from,
    covered_to,
  };
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const text = await pdfToText(filePath, true);
  const filename = basename(filePath);
  if (/^bofa-credit-card-/i.test(filename) || (/Payment Information/.test(text) && /New Balance Total/.test(text))) {
    return parseCreditCard(text, filePath);
  }
  return parseDeposit(text, filePath);
}
