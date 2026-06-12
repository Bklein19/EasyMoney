import { basename } from "path";
import type { ParseResult, ParserMeta } from "../src/types";
import { cents, pdfToText } from "./_helpers";

export const meta: ParserMeta = {
  id: "merrill-cma-statement-pdf",
  institution: "Merrill",
  kind: "statement",
  priority: 50,
  matches: ({ filename, sample }) =>
    /^merrill-statement-\d{4}-STMT_\d{8}_XXXXX\d+_CMAEdge\.pdf$/i.test(filename) ||
    (/Account Number:\s*\d{2}W-\d{5}/.test(sample) && /CMA[®\s]+ACCOUNT/.test(sample)),
};

function statementDate(filePath: string): string {
  const m = basename(filePath).match(/STMT_(\d{2})(\d{2})(\d{4})_/);
  if (!m) throw new Error("Could not find statement date in Merrill filename");
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function parseBalance(value: string): number {
  return value.trim() === "-" ? 0 : cents(value);
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const text = await pdfToText(filePath, true);
  const date = statementDate(filePath);

  const accountMatch = text.match(/Account Number:\s*(\d{2}W-\d{5})/);
  if (!accountMatch) throw new Error("Could not find Merrill account number");
  const account = `CMA-Edge - ${accountMatch[1]}`;

  const balanceMatch =
    text.match(/Closing Value \(\d{2}\/\d{2}\)\s+(\$?[\d,]+\.\d{2}|-)/) ||
    text.match(/Net Portfolio Value:\s+(\$?[\d,]+\.\d{2}|-)/);
  if (!balanceMatch) throw new Error("Could not find Merrill closing value");

  return {
    transactions: [],
    balances: [
      {
        date,
        account,
        institution: "Merrill",
        balance_cents: parseBalance(balanceMatch[1]!),
      },
    ],
    covered_from: date,
    covered_to: date,
  };
}
