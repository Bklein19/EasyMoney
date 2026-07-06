import type { ParseResult, ParserMeta } from "./types.ts";
import { makeTx } from "./_helpers";

export const meta: ParserMeta = {
  id: "fidelity-401k-html",
  institution: "Fidelity",
  kind: "statement",
  priority: 50,
  matches: ({ filename }) => /^fidelity-401k-[a-z0-9-]+-\d{4}-\d{2}\.html$/i.test(filename),
};

const ACCOUNT = "Fidelity 401(k)";

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}

function iso(mmddyyyy: string): string {
  const [mm, dd, yyyy] = mmddyyyy.split("/");
  return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
}

function cents(s: string): number {
  const neg = s.includes("(") || s.startsWith("-");
  return (neg ? -1 : 1) * Math.round(parseFloat(s.replace(/[^0-9.]/g, "")) * 100);
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const text = stripHtml(await Bun.file(filePath).text());

  // Statement Period: 06/01/2023 to 06/30/2023
  const pm = text.match(/Statement Period:\s*(\d{2}\/\d{2}\/\d{4})\s+to\s+(\d{2}\/\d{2}\/\d{4})/);
  const covered_from = pm ? iso(pm[1]!) : "";
  const covered_to = pm ? iso(pm[2]!) : "";

  // Ending Balance $81,937.05
  const bm = text.match(/Ending Balance\s+\$([\d,]+\.\d{2})/);
  const balances: ParseResult["balances"] = bm && covered_to
    ? [{ date: covered_to, account: ACCOUNT, institution: "Fidelity", balance_cents: cents(bm[1]!) }]
    : [];

  // "Your Contributions $1,345.84" — period contributions (employee + employer)
  const transactions: ParseResult["transactions"] = [];
  const cm = text.match(/Your Contributions\s+\$([\d,]+\.\d{2})/);
  if (cm && covered_to) {
    const amount_cents = cents(cm[1]!);
    if (amount_cents !== 0) {
      transactions.push(
        makeTx({
          date: covered_to,
          amount_cents,
          description: "401(k) contributions (employee + employer)",
          account: ACCOUNT,
          institution: "Fidelity",
          raw: { source: "401k-statement-summary", period: `${covered_from}/${covered_to}`, your_contributions: cm[1] },
        })
      );
    }
  }

  return { transactions, balances, covered_from, covered_to };
}
