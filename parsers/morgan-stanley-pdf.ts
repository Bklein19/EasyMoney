import type { ParseResult, ParserMeta } from "../src/types";
import { pdfToText, makeTx } from "./_helpers";

export const meta: ParserMeta = {
  id: "morgan-stanley-pdf",
  institution: "Morgan Stanley",
  kind: "statement",
  priority: 50,
  // Monthly/annual/consolidated/recap statements. NOT AllActivity.pdf (that's the
  // activity export, handled by morgan-stanley-activity-pdf).
  matches: ({ filename }) => /^morgan-stanley-\d+-\d{4}-\d{2}-\d{2}-.+\.pdf$/.test(filename),
};

function iso(month: string, day: number, year: number): string {
  const months: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
  };
  const m = months[month.toLowerCase()] || "01";
  return `${year}-${m}-${String(day).padStart(2, "0")}`;
}

function cents(s: string): number {
  const neg = s.includes("(") || s.startsWith("-");
  return (neg ? -1 : 1) * Math.round(parseFloat(s.replace(/[^0-9.]/g, "")) * 100);
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const text = await pdfToText(filePath);

  // "For the Period June 1-30, 2019" — monthly statement (same-month start/end)
  const periodMatch = text.match(/For the Period ([A-Za-z]+) (\d+)[-–](\d+),\s*(\d{4})/);
  if (!periodMatch) {
    // Annual or other format — skip (monthly data already covers it)
    return { transactions: [], balances: [], covered_from: "", covered_to: "" };
  }

  const covered_from = iso(periodMatch[1]!, parseInt(periodMatch[2]!), parseInt(periodMatch[4]!));
  const covered_to = iso(periodMatch[1]!, parseInt(periodMatch[3]!), parseInt(periodMatch[4]!));

  // Skip consolidated statements (aggregate multiple accounts)
  if (text.includes("TOTAL VALUE OF YOUR ACCOUNTS")) {
    return { transactions: [], balances: [], covered_from, covered_to };
  }

  // Account number: "304 - 020854 - 002" → last 4 of middle segment
  const acctMatch = text.match(/304\s*-\s*0?(\d{4,6})\s*-\s*\d+/);
  const acctNum = acctMatch ? acctMatch[1]!.slice(-4) : "";
  const accountName =
    acctNum === "0854" ? "Morgan Stanley Roth IRA"
    : acctNum === "7571" ? "Morgan Stanley Traditional IRA"
    : `Morgan Stanley IRA -${acctNum}`;

  // Old format: "$8,161.77\nTOTAL VALUE OF YOUR ACCOUNT"
  // New format: "$74,214.06\n$74,655.62\n…Beginning Total Value…Ending Total Value…"
  // An em-dash "—" in place of a dollar value means zero (account emptied/closed).
  let balCents: number | null = null;
  const oldFormatMatch = text.match(/(\$[\d,]+\.\d{2}|—)\s*\n\s*TOTAL VALUE OF YOUR ACCOUNT[^S]/);
  if (oldFormatMatch) {
    balCents = oldFormatMatch[1] === "—" ? 0 : cents(oldFormatMatch[1]!);
  } else {
    const newFormatMatch = text.match(
      /(\$[\d,]+\.\d{2}|—)\s*\n(\$[\d,]+\.\d{2}|—)\s*\n[\s\S]{0,50}Beginning Total Value[\s\S]{0,80}Ending Total Value/
    );
    if (newFormatMatch) balCents = newFormatMatch[2] === "—" ? 0 : cents(newFormatMatch[2]!);
  }

  const balances = balCents !== null && covered_to && acctNum
    ? [{ date: covered_to, account: accountName, institution: "Morgan Stanley", balance_cents: balCents }]
    : [];

  // SECURITY TRANSFERS — in-kind ACAT moves. These never appear in the activity
  // export, so the statement is the authoritative source for them.
  // `4/8  Transfer out of Account  VANGUARD FTSE…  TO  VANGUARD MARKETING CORPO  287.000  $(19,464.34)`
  const transactions: ParseResult["transactions"] = [];
  if (acctNum) {
    const layoutText = await pdfToText(filePath, true);
    const year = parseInt(covered_to.slice(0, 4));
    let inSection = false;
    for (const line of layoutText.split("\n")) {
      if (/^\s*SECURITY TRANSFERS\s*$/.test(line)) { inSection = true; continue; }
      if (inSection && /^\s*TOTAL SECURITY TRANSFERS/.test(line)) { inSection = false; continue; }
      if (!inSection) continue;
      const m = line.match(
        /^\s*(\d{1,2})\/(\d{1,2})\s+(Transfer (?:out of|into) Account)\s+(.+?)\s{2,}((?:TO|FROM)\s+\S.*?)\s{2,}[\d,.]+\s+(\(?)\$?\(?([\d,]+\.\d{2})\)?\s*$/
      );
      if (!m) continue;
      const date = `${year}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
      const neg = m[6] === "(" || line.includes("(");
      const amount_cents = (neg ? -1 : 1) * Math.round(parseFloat(m[7]!.replace(/,/g, "")) * 100);
      const description = `${m[3]} ${m[4]!.trim()} ${m[5]!.replace(/\s+/g, " ").trim()}`;
      transactions.push(
        makeTx({
          date, amount_cents, description,
          account: accountName, institution: "Morgan Stanley",
          raw: { type: "security-transfer", date, description, amount_cents },
        })
      );
    }
  }

  return { transactions, balances, covered_from, covered_to };
}
