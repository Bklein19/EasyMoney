import type { ParseResult, ParserMeta } from "../src/types";
import { cents, pdfToText } from "./_helpers";

export const meta: ParserMeta = {
  id: "tiaa-statement-pdf",
  institution: "TIAA",
  kind: "statement",
  priority: 50,
  matches: ({ filename, sample }) =>
    /^tiaa-\d{4}-\d{2}-\d{2}-retirement-q[1-4]-\d{4}-\d+\.pdf$/i.test(filename) ||
    /Quarterly retirement savings portfolio statement/.test(sample),
};

const ACCOUNT = "Retirement Annuity";

const MONTHS: Record<string, string> = {
  January: "01",
  February: "02",
  March: "03",
  April: "04",
  May: "05",
  June: "06",
  July: "07",
  August: "08",
  September: "09",
  October: "10",
  November: "11",
  December: "12",
};

function isoLongDate(value: string): string {
  const m = value.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m || !MONTHS[m[1]!]) throw new Error(`Invalid TIAA statement date: ${value}`);
  return `${m[3]}-${MONTHS[m[1]!]}-${String(Number(m[2])).padStart(2, "0")}`;
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const text = await pdfToText(filePath);

  const balanceMatch = text.match(
    /Your balance on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4}):[\s\S]*?\$([\d,]+\.\d{2})/
  );
  if (!balanceMatch) throw new Error("Could not find TIAA statement balance");

  const statementDate = isoLongDate(balanceMatch[1]!);
  const balance_cents = cents(balanceMatch[2]!);

  const periodMatch = text.match(
    /For\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})\s+to\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/
  );

  return {
    transactions: [],
    balances: [{ date: statementDate, account: ACCOUNT, institution: "TIAA", balance_cents }],
    covered_from: periodMatch ? isoLongDate(periodMatch[1]!) : statementDate,
    covered_to: periodMatch ? isoLongDate(periodMatch[2]!) : statementDate,
  };
}
