import type { ParseResult, ParserMeta } from "../src/types";
import { getDocumentProxy, extractText } from "unpdf";
import { cents, makeTx } from "./_helpers";

export const meta: ParserMeta = {
  id: "fidelity-portfolio-statement-pdf",
  institution: "Fidelity",
  kind: "statement",
  priority: 50,
  matches: ({ filename, sample }) =>
    /^\d{4}-\d{2}-.+-Fidelity-Statement\.pdf$/i.test(filename) ||
    /^[A-Za-z]+(?:-[A-Za-z]+)? \d{4}-.+-Fidelity-Statement\.pdf$/i.test(filename) ||
    (/\.pdf$/i.test(filename) &&
      /INVESTMENT REPORT/i.test(sample) &&
      /Account (?:Number|#):\s*\d{3}-\d{6}/i.test(sample) &&
      /(?:Your Account Value|Ending Account Value)/i.test(sample)),
};

const titleCase = (value: string) =>
  value.toLowerCase().replace(/\b[a-z]/g, char => char.toUpperCase());

function isoLongDate(value: string): string {
  const date = new Date(`${value} UTC`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid Fidelity statement date: ${value}`);
  return date.toISOString().slice(0, 10);
}

function dateYearFor(mm: string, coveredFrom: string, coveredTo: string): string {
  const fromYear = Number(coveredFrom.slice(0, 4));
  const toYear = Number(coveredTo.slice(0, 4));
  const fromMonth = Number(coveredFrom.slice(5, 7));
  const month = Number(mm);
  return String(fromYear === toYear ? fromYear : month >= fromMonth ? fromYear : toYear);
}

function parseAccount(text: string): string {
  const number = text.match(/Account (?:Number|#):\s*(\d{3})-(\d{6})/i);
  if (!number) throw new Error("Could not find Fidelity portfolio account number");
  const digits = `${number[1]}${number[2]}`;
  const label = text.match(/Account Summary\s+ALEX EXAMPLE\s+-\s+([A-Z ]+?)\s+Account Value/i)?.[1] ||
    text.match(/ALEX EXAMPLE\s+-\s+([A-Z ]+?)(?:\s+Account Value|\s+This Period|\n)/i)?.[1] ||
    text.match(/FIDELITY\s+([A-Z ]+?)\s+ALEX EXAMPLE/i)?.[1] ||
    "Portfolio Account";
  const cleanedLabel = label.replace(/account\s*summary/i, "").trim();
  return `${titleCase(cleanedLabel)} ${digits}`;
}

function parseContributionRows(text: string, account: string, coveredFrom: string, coveredTo: string): ParseResult["transactions"] {
  const transactions: ParseResult["transactions"] = [];
  const section = text.match(/Contributions\s+Date Reference Description Amount\s+([\s\S]*?)Total Contributions\s+\$?[\d,]+\.\d{2}/i)?.[1];
  if (!section) return transactions;

  for (const rawLine of section.split("\n")) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const match = line.match(/^(\d{2})\/(\d{2})\s+(.+?)\s+\$?([\d,]+\.\d{2})$/);
    if (!match) continue;
    const [, mm, dd, description, amount] = match;
    const date = `${dateYearFor(mm!, coveredFrom, coveredTo)}-${mm}-${dd}`;
    const amount_cents = cents(amount!);
    if (amount_cents === 0) continue;
    transactions.push(makeTx({
      date,
      amount_cents,
      description: `Fidelity contribution: ${description!.trim()}`,
      account,
      institution: "Fidelity",
      raw: {
        source: "fidelity-portfolio-statement",
        type: "contribution",
        period: `${coveredFrom}/${coveredTo}`,
        description: description!.trim(),
        amount,
      },
    }));
  }

  return transactions;
}

function parseDistributionRows(text: string, account: string, coveredFrom: string, coveredTo: string): ParseResult["transactions"] {
  const transactions: ParseResult["transactions"] = [];
  const section = text.match(/Distributions\s+Date Reference Description Amount\s+([\s\S]*?)Total Distributions\s+(-|\(?-?\$?[\d,]+\.\d{2}\)?)/i)?.[1];
  if (!section) return transactions;

  for (const rawLine of section.split("\n")) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const match = line.match(/^(\d{2})\/(\d{2})\s+(.+?)\s+(-?\$?[\d,]+\.\d{2}|\(\$?[\d,]+\.\d{2}\))$/);
    if (!match) continue;
    const [, mm, dd, description, amount] = match;
    const date = `${dateYearFor(mm!, coveredFrom, coveredTo)}-${mm}-${dd}`;
    const amount_cents = -Math.abs(cents(amount!));
    if (amount_cents === 0) continue;
    transactions.push(makeTx({
      date,
      amount_cents,
      description: `Fidelity transfer out: ${description!.trim()}`,
      account,
      institution: "Fidelity",
      raw: {
        source: "fidelity-portfolio-statement",
        type: "distribution",
        period: `${coveredFrom}/${coveredTo}`,
        description: description!.trim(),
        amount,
      },
    }));
  }

  return transactions;
}

function parseSecuritiesTransferredOut(text: string, account: string, coveredFrom: string, coveredTo: string): ParseResult["transactions"] {
  const summary = text.match(/Securities Transferred Out\s+(-|-?\$?[\d,]+\.\d{2})\s+(-|-?\$?[\d,]+\.\d{2})/i);
  const amount = summary?.[1];
  if (!amount || amount === "-") return [];

  const amount_cents = -Math.abs(cents(amount));
  if (amount_cents === 0) return [];

  const activityDate = text.match(/Securities Transferred Out[\s\S]*?(\d{2})\/(\d{2})\s+[A-Z0-9]/i);
  const mm = activityDate?.[1] ?? coveredTo.slice(5, 7);
  const dd = activityDate?.[2] ?? coveredTo.slice(8, 10);
  const date = `${dateYearFor(mm, coveredFrom, coveredTo)}-${mm}-${dd}`;

  return [makeTx({
    date,
    amount_cents,
    description: "Fidelity transfer out: securities transferred out",
    account,
    institution: "Fidelity",
    raw: {
      source: "fidelity-portfolio-statement",
      type: "securities-transferred-out",
      period: `${coveredFrom}/${coveredTo}`,
      amount,
    },
  })];
}

export function parseFidelityPortfolioStatementText(text: string): ParseResult {
  const fullText = text.replace(/\u00a0/g, " ");
  const period = fullText.match(/([A-Z][a-z]+ \d{1,2}, \d{4})\s*-\s*([A-Z][a-z]+ \d{1,2}, \d{4})/);
  if (!period) throw new Error("Could not find Fidelity portfolio statement period");

  const covered_from = isoLongDate(period[1]!);
  const covered_to = isoLongDate(period[2]!);
  const account = parseAccount(fullText);
  const balance =
    fullText.match(/Your Account Value:?\s*(-|\$[\d,]+\.\d{2})/) ||
    fullText.match(/Ending Account Value\s*\**\s*(-|\$[\d,]+\.\d{2})/);
  if (!balance) throw new Error("Could not find Fidelity portfolio ending balance");

  const balance_cents = balance[1] === "-" ? 0 : cents(balance[1]!);
  const transactions = [
    ...parseContributionRows(fullText, account, covered_from, covered_to),
    ...parseDistributionRows(fullText, account, covered_from, covered_to),
    ...parseSecuritiesTransferredOut(fullText, account, covered_from, covered_to),
  ];

  return {
    covered_from,
    covered_to,
    transactions,
    balances: [{ date: covered_to, account, institution: "Fidelity", balance_cents }],
  };
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
  const { text } = await extractText(pdf);
  return parseFidelityPortfolioStatementText(text.join("\n"));
}
