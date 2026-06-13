import { basename } from "path";
import type { ParseResult, ParserMeta } from "../src/types";
import { cents, makeTx, pdfToText } from "./_helpers";

export const meta: ParserMeta = {
  id: "wells-fargo-statement-pdf",
  institution: "Wells Fargo",
  kind: "statement",
  priority: 50,
  matches: ({ filename, sample }) =>
    /^wells-fargo-(checking|autograph-visa|platinum-card)-\d{4}-\d{4}-\d{2}-\d{2}\.pdf$/i.test(filename) ||
    (/Wells Fargo/i.test(sample) &&
      (/Wells Fargo Everyday Checking/.test(sample) ||
        /WELLS FARGO AUTOGRAPH VISA/i.test(sample) ||
        (/WELLS FARGO CREDIT CARD/i.test(sample) && /Account ending in/.test(sample)))),
};

function cleanDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function filenameAccount(filePath: string): { slug?: string; last4?: string; date?: string } {
  const filename = basename(filePath).replace(/^[0-9a-f]{64}-/, "");
  const m = filename.match(/^wells-fargo-(checking|autograph-visa|platinum-card)-(\d{4})-(\d{4}-\d{2}-\d{2})\.pdf$/i);
  return { slug: m?.[1]?.toLowerCase(), last4: m?.[2], date: m?.[3] };
}

function isoNumericDate(monthRaw: string, dayRaw: string, yearRaw: string): string {
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  if (!month || !day || !year) throw new Error(`Invalid Wells Fargo date: ${monthRaw}/${dayRaw}/${yearRaw}`);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isoStatementMonthDate(monthRaw: string, dayRaw: string, coveredTo: string): string {
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const endYear = Number(coveredTo.slice(0, 4));
  const endMonth = Number(coveredTo.slice(5, 7));
  const year = month > endMonth ? endYear - 1 : endYear;
  if (!month || !day || !year) throw new Error(`Invalid Wells Fargo statement date: ${monthRaw}/${dayRaw}`);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function accountLast4(text: string, filePath: string): string {
  const fromFilename = filenameAccount(filePath).last4;
  const fromText =
    text.match(/Account ending in\s+(\d{4})/i)?.[1] ??
    text.match(/Account number:\s*\d*(\d{4})/i)?.[1] ??
    text.match(/Account Number\s+(?:\d{4}\s+){3}(\d{4})/i)?.[1];
  const last4 = fromFilename ?? fromText;
  if (!last4) throw new Error("Could not find Wells Fargo account number");
  return last4;
}

function depositAccountName(text: string, filePath: string): string {
  const last4 = accountLast4(text, filePath);
  return `Checking - ${last4}`;
}

function cardAccountName(text: string, filePath: string): string {
  const { slug } = filenameAccount(filePath);
  const last4 = accountLast4(text, filePath);
  if (slug === "autograph-visa" || /AUTOGRAPH VISA/i.test(text)) return `Autograph Visa - ${last4}`;
  return `Platinum Card - ${last4}`;
}

function parseDepositPeriod(text: string, filePath: string): { covered_from: string; covered_to: string } {
  const filenameDate = filenameAccount(filePath).date;
  const ending = text.match(/Ending balance on\s+(\d{1,2})\/(\d{1,2})\s+\$?[\d,]+\.\d{2}/);
  const beginning = text.match(/Beginning balance on\s+(\d{1,2})\/(\d{1,2})\s+\$?[\d,]+\.\d{2}/);
  if (!filenameDate || !ending || !beginning) throw new Error("Could not find Wells Fargo checking statement period");

  const covered_to = filenameDate;
  const covered_from = isoStatementMonthDate(beginning[1]!, beginning[2]!, covered_to);
  return { covered_from, covered_to };
}

function parseCardPeriod(text: string): { covered_from: string; covered_to: string } {
  const period = text.match(/Statement Period\s+(\d{2})\/(\d{2})\/(\d{4})\s+to\s+(\d{2})\/(\d{2})\/(\d{4})/);
  if (!period) throw new Error("Could not find Wells Fargo credit card statement period");
  return {
    covered_from: isoNumericDate(period[1]!, period[2]!, period[3]!),
    covered_to: isoNumericDate(period[4]!, period[5]!, period[6]!),
  };
}

function parseDepositTransactions(text: string, account: string, coveredTo: string): ParseResult["transactions"] {
  const lines = text.split(/\n/);
  const header = lines.find((line) => /Deposits\/\s+Withdrawals\/\s+Ending daily/i.test(line));
  const depositCol = header?.indexOf("Deposits/") ?? 105;
  const withdrawalCol = header?.indexOf("Withdrawals/") ?? 124;
  const endingCol = header?.indexOf("Ending daily") ?? 145;

  const transactions: ParseResult["transactions"] = [];
  let current:
    | {
        date: string;
        description: string;
        amount_cents: number;
      }
    | undefined;
  let inHistory = false;

  const flush = () => {
    if (!current) return;
    transactions.push(
      makeTx({
        date: current.date,
        amount_cents: current.amount_cents,
        description: cleanDescription(current.description),
        account,
        institution: "Wells Fargo",
        raw: { source: "wells-fargo-statement", type: "checking-activity" },
      })
    );
    current = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");
    const trimmed = line.trim();
    if (/^Transaction history$/i.test(trimmed)) {
      inHistory = true;
      continue;
    }
    if (!inHistory) continue;
    if (/^Totals\b/i.test(trimmed) || /^Monthly service fee summary$/i.test(trimmed)) {
      flush();
      break;
    }

    const row = line.match(/^\s*(\d{1,2})\/(\d{1,2})\s+(.*)$/);
    if (row) {
      const restStart = row[0].indexOf(row[3]!);
      const rest = row[3]!;
      const moneyMatches = [...rest.matchAll(/\$?[\d,]+\.\d{2}/g)];
      if (moneyMatches.length === 0) {
        flush();
        current = undefined;
        continue;
      }

      const firstMoney = moneyMatches[0]!;
      const firstMoneyCol = restStart + firstMoney.index!;
      const isEndingBalanceOnly = firstMoneyCol >= endingCol - 4 && moneyMatches.length === 1;
      if (isEndingBalanceOnly) continue;

      const amount = cents(firstMoney[0]);
      const signed = firstMoneyCol >= withdrawalCol - 4 ? -Math.abs(amount) : Math.abs(amount);
      const description = cleanDescription(rest.slice(0, firstMoney.index).trim());
      flush();
      current = {
        date: isoStatementMonthDate(row[1]!, row[2]!, coveredTo),
        description,
        amount_cents: signed,
      };
      continue;
    }

    if (current && /^\s{8,}\S/.test(line) && !/^Page \d+/.test(trimmed)) {
      const cutAt = Math.min(
        ...[depositCol, withdrawalCol, endingCol].filter((n) => n > 0 && n < line.length)
      );
      current.description += ` ${line.slice(0, cutAt).trim()}`;
    }
  }

  flush();
  return transactions;
}

function parseCardTransactions(text: string, account: string, coveredTo: string): ParseResult["transactions"] {
  const transactions: ParseResult["transactions"] = [];
  const lines = text.split(/\n/);
  let section = "";

  const signForSection = (value: number, currentSection: string): number => {
    if (/Payments|Other Credits/i.test(currentSection)) return -Math.abs(value);
    return Math.abs(value);
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");
    const trimmed = line.trim();

    if (/^(Payments|Other Credits|Purchases, Balance Transfers & Other Charges|Cash Advances|Fees Charged|Interest Charged)$/.test(trimmed)) {
      section = trimmed;
      continue;
    }
    if (!section || /^TOTAL\b/i.test(trimmed) || /^202\d Totals Year-to-Date$/i.test(trimmed)) continue;

    const payment = line.match(/^\s*(\d{2})\/(\d{2})\s+(\d{2})\/(\d{2})\s+([A-Z0-9]+)\s+(.+?)\s+([\d,]+\.\d{2})\s*$/);
    const charge = line.match(/^\s*\d{4}\s+(\d{2})\/(\d{2})\s+(\d{2})\/(\d{2})\s+([A-Z0-9]+)\s+(.+?)\s+([\d,]+\.\d{2})\s*$/);
    const interest = line.match(/^\s*(INTEREST CHARGE .+?)\s+([\d,]+\.\d{2})\s*$/);

    if (payment && /Payments|Other Credits/i.test(section)) {
      const amount = cents(payment[7]!);
      if (amount === 0) continue;
      transactions.push(
        makeTx({
          date: isoStatementMonthDate(payment[3]!, payment[4]!, coveredTo),
          amount_cents: signForSection(amount, section),
          description: cleanDescription(payment[6]!),
          account,
          institution: "Wells Fargo",
          raw: { source: "wells-fargo-statement", type: "credit-card-activity", section, reference: payment[5] },
        })
      );
      continue;
    }

    if (charge && !/Payments|Other Credits/i.test(section)) {
      const amount = cents(charge[7]!);
      if (amount === 0) continue;
      transactions.push(
        makeTx({
          date: isoStatementMonthDate(charge[3]!, charge[4]!, coveredTo),
          amount_cents: signForSection(amount, section),
          description: cleanDescription(charge[6]!),
          account,
          institution: "Wells Fargo",
          raw: { source: "wells-fargo-statement", type: "credit-card-activity", section, reference: charge[5] },
        })
      );
      continue;
    }

    if (interest && /Interest Charged/i.test(section)) {
      const amount = cents(interest[2]!);
      if (amount === 0) continue;
      transactions.push(
        makeTx({
          date: coveredTo,
          amount_cents: Math.abs(amount),
          description: cleanDescription(interest[1]!),
          account,
          institution: "Wells Fargo",
          raw: { source: "wells-fargo-statement", type: "credit-card-activity", section },
        })
      );
    }
  }

  return transactions;
}

function parseDeposit(text: string, filePath: string): ParseResult {
  const account = depositAccountName(text, filePath);
  const { covered_from, covered_to } = parseDepositPeriod(text, filePath);
  const balance = text.match(/Ending balance on\s+\d{1,2}\/\d{1,2}\s+\$?([\d,]+\.\d{2})/);
  if (!balance) throw new Error("Could not find Wells Fargo checking ending balance");

  return {
    transactions: parseDepositTransactions(text, account, covered_to),
    balances: [
      {
        date: covered_to,
        account,
        institution: "Wells Fargo",
        balance_cents: cents(balance[1]!),
      },
    ],
    covered_from,
    covered_to,
  };
}

function parseCreditCard(text: string, filePath: string): ParseResult {
  const account = cardAccountName(text, filePath);
  const { covered_from, covered_to } = parseCardPeriod(text);
  const balance = text.match(/New Balance\s+\$?([\d,]+\.\d{2})/);
  if (!balance) throw new Error("Could not find Wells Fargo credit card new balance");

  return {
    transactions: parseCardTransactions(text, account, covered_to),
    balances: [
      {
        date: covered_to,
        account,
        institution: "Wells Fargo",
        balance_cents: -Math.abs(cents(balance[1]!)),
      },
    ],
    covered_from,
    covered_to,
  };
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const text = await pdfToText(filePath, true);
  if (/Wells Fargo Everyday Checking/i.test(text)) return parseDeposit(text, filePath);
  return parseCreditCard(text, filePath);
}
