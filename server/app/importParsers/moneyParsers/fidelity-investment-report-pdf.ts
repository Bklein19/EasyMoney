import type { ParseResult, ParserMeta } from "./types.ts";
import { makeTx, pdfToText } from "./_helpers";
import { getDocumentProxy, extractText } from "unpdf";

export const meta: ParserMeta = {
  id: "fidelity-investment-report-pdf",
  institution: "Fidelity",
  kind: "statement",
  priority: 50,
  matches: ({ filename }) => /^fidelity-Z\d+-\d{4}-\d{2}-\d{2}\.pdf$/.test(filename),
};

function parseMoneyToCents(s: string): number {
  return Math.round(parseFloat(s.replace(/[$,]/g, "").trim()) * 100);
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const buf = await Bun.file(filePath).arrayBuffer();
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text: pageTexts } = await extractText(pdf);
  const fullText = pageTexts.join("\n");

  const dateRangeMatch = fullText.match(/([A-Z][a-z]+ \d{1,2}, \d{4})\s*-\s*([A-Z][a-z]+ \d{1,2}, \d{4})/);
  if (!dateRangeMatch) throw new Error("Could not find statement date range");

  const accountMatch = fullText.match(/Account Number:\s*([A-Z0-9-]+)/) || fullText.match(/Account #\s*([A-Z0-9-]+)/);
  if (!accountMatch) throw new Error("Could not find account number");
  const account = accountMatch[1]!;

  // Account value only — "Total Including Other Holdings" adds unvested Stock Plans
  // (RSUs), which shouldn't count toward net worth until they vest. A "-" means zero.
  const balanceMatch =
    fullText.match(/Your Account Value:?\s*(-|\$[0-9,]+\.\d{2})/) ||
    fullText.match(/Ending Account Value\s*\**\s*(-|\$[0-9,]+\.\d{2})/);
  if (!balanceMatch) throw new Error("Could not find ending balance");
  const balance_cents = balanceMatch[1] === "-" ? 0 : parseMoneyToCents(balanceMatch[1]!);

  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  const toIso = (s: string) => fmt.format(new Date(s));
  const covered_from = toIso(dateRangeMatch[1]!);
  const covered_to = toIso(dateRangeMatch[2]!);

  const balances = [{ date: covered_to, account, institution: "Fidelity", balance_cents }];

  // Dated activity: RSU vests, ESPP purchases, tax journals, EFT transfers — external
  // flows (compensation in, taxes/cash out). Regular buys/sells are internal, skipped.
  const transactions: ParseResult["transactions"] = [];
  const layoutText = await pdfToText(filePath, true);

  const fromYear = parseInt(covered_from.slice(0, 4));
  const toYear = parseInt(covered_to.slice(0, 4));
  const fromMonth = parseInt(covered_from.slice(5, 7));
  const yearFor = (mm: number) => (fromYear === toYear ? fromYear : mm >= fromMonth ? fromYear : toYear);
  const isoDate = (mm: string, dd: string) => `${yearFor(parseInt(mm))}-${mm}-${dd}`;
  const num = (s: string) => parseFloat(s.replace(/[$,]/g, ""));

  const push = (date: string, amount_cents: number, description: string, raw: Record<string, unknown>) => {
    if (amount_cents === 0) return;
    transactions.push(makeTx({ date, amount_cents, description, account, institution: "Fidelity", raw }));
  };

  for (const line of layoutText.split("\n")) {
    // RSU vest: shares granted at no cash cost — amount columns are "- -"
    let m = line.match(/^\s*\S?\s*(\d{2})\/(\d{2})\s+(\S.*?RSU#*\S*)\s+\d{6,9}\s+You Bought\s+([\d,.]+)\s+\$?([\d,.]+)\s+-\s+-\s*$/);
    if (m) {
      const date = isoDate(m[1]!, m[2]!);
      push(date, Math.round(num(m[4]!) * num(m[5]!) * 100), `RSU vest: ${m[3]!.trim()} ${m[4]} @ ${m[5]}`,
        { type: "rsu-vest", date, security: m[3]!.trim(), qty: m[4], price: m[5] });
      continue;
    }
    // ESPP purchase: payroll cash buys shares — trailing negative cash amount
    m = line.match(/^\s*\S?\s*(\d{2})\/(\d{2})\s+(\S.*?ESPP#*\S*)\s+\d{6,9}\s+You Bought\s+([\d,.]+)\s+\$?([\d,.]+)\s+\S*\s+-\$?([\d,.]+)\s*$/);
    if (m) {
      const date = isoDate(m[1]!, m[2]!);
      push(date, Math.round(num(m[6]!) * 100), `ESPP purchase (payroll): ${m[3]!.trim()} ${m[4]} @ ${m[5]}`,
        { type: "espp-purchase", date, security: m[3]!.trim(), qty: m[4], price: m[5], amount: m[6] });
      continue;
    }
    // Tax withholding journaled out of the account
    m = line.match(/^\s*(\d{2})\/(\d{2})\s+(\S.*?)\s+Journaled\b.*?(-?)\$?([\d,]+\.\d{2})\s*$/);
    if (m) {
      if (/purchase credit/i.test(m[3]!)) continue; // ESPP credit already captured by the buy
      const date = isoDate(m[1]!, m[2]!);
      const sign = m[4] === "-" ? -1 : 1;
      push(date, sign * Math.round(num(m[5]!) * 100), `Tax journaled: ${m[3]!.trim()}`,
        { type: "journaled", date, label: m[3]!.trim(), amount: `${m[4]}${m[5]}` });
      continue;
    }
    // Cash to/from bank
    m = line.match(/^\s*(\d{2})\/(\d{2})\s+(Money Line (?:Paid|Received))\s+(\S.*?)\s+(-?)\$?([\d,]+\.\d{2})\s*$/);
    if (m) {
      const date = isoDate(m[1]!, m[2]!);
      const sign = m[5] === "-" ? -1 : 1;
      push(date, sign * Math.round(num(m[6]!) * 100), `${m[3]} ${m[4]!.trim()}`,
        { type: "money-line", date, detail: m[4]!.trim(), amount: `${m[5]}${m[6]}` });
      continue;
    }
  }

  return { transactions, balances, covered_from, covered_to };
}
