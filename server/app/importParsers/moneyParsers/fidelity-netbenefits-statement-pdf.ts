import type { ParseResult, ParserMeta } from "./types.ts";
import { getDocumentProxy, extractText } from "unpdf";
import { cents } from "./_helpers";

export const meta: ParserMeta = {
  id: "fidelity-netbenefits-statement-pdf",
  institution: "Fidelity",
  kind: "statement",
  priority: 50,
  matches: ({ filename, sample }) =>
    /^\d{4}-\d{2}-[A-Za-z]+-.+-401k-Fidelity-NetBenefits-Statement\.pdf$/i.test(filename) ||
    (/\.pdf$/i.test(filename) &&
      /Fidelity NetBenefits|Retirement Savings Statement|Statement Details/i.test(sample) &&
      /Statement Period:\s*\d{2}\/\d{2}\/\d{4}\s+to\s+\d{2}\/\d{2}\/\d{4}/i.test(sample) &&
      /Ending Balance\s+\$?[\d,]+\.\d{2}/i.test(sample)),
};

function iso(mmddyyyy: string): string {
  const [mm, dd, yyyy] = mmddyyyy.split("/");
  return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
}

function accountName(text: string): string {
  const plan = text.match(/([A-Z][A-Za-z0-9&.,' -]+?)\s+401\(k\) Plan\s+Retirement Savings Statement/i);
  if (plan) return `${plan[1]!.trim()} 401(k)`;
  return "Fidelity NetBenefits 401(k)";
}

export function parseNetBenefitsStatementText(text: string): ParseResult {
  const normalized = text.replace(/\u00a0/g, " ");
  const period = normalized.match(/Statement Period:\s*(\d{2}\/\d{2}\/\d{4})\s+to\s+(\d{2}\/\d{2}\/\d{4})/i);
  if (!period) throw new Error("Could not find Fidelity NetBenefits statement period");

  const covered_from = iso(period[1]!);
  const covered_to = iso(period[2]!);
  const account = accountName(normalized);

  const endingBalance = normalized.match(/Ending Balance\s+\$?([\d,]+\.\d{2})/i);
  if (!endingBalance) throw new Error("Could not find Fidelity NetBenefits ending balance");

  const balances: ParseResult["balances"] = [{
    date: covered_to,
    account,
    institution: "Fidelity",
    balance_cents: cents(endingBalance[1]!),
  }];

  // Contribution totals have no individual event dates. Activity exports supply events.
  return { transactions: [], balances, covered_from, covered_to };
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
  const { text } = await extractText(pdf);
  return parseNetBenefitsStatementText(text.join("\n"));
}
