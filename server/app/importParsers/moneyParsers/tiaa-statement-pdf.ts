import type { ParseResult, ParserMeta } from "./types.ts";
import { cents, pdfToText, makeTx } from "./_helpers";

export const meta: ParserMeta = {
  id: "tiaa-statement-pdf",
  institution: "TIAA",
  kind: "statement",
  priority: 50,
  matches: ({ filename, sample }) =>
    /^tiaa-\d{4}-\d{2}-\d{2}-retirement-q[1-4]-\d{4}-(?:\d+|[a-f0-9]{12})\.pdf$/i.test(filename) ||
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
  const covered_from = periodMatch ? isoLongDate(periodMatch[1]!) : statementDate;
  const covered_to = periodMatch ? isoLongDate(periodMatch[2]!) : statementDate;

  // Quarterly contribution totals come from the activity-summary block, which only
  // keeps label and value on one line in layout mode. The CSV activity export records
  // only fund-level Buy/Sell/ReinvDiv with no contribution marker, so the statement is
  // the authoritative source for TIAA contributions. Take the FIRST match of each
  // label — later "Your contributions" lines are per-fund breakdowns, not the summary.
  // Older statements (pre-2024-Q3) omit the "$" on summary values; newer ones include
  // it. Match either. First occurrence is the summary block; later same-label lines are
  // per-fund breakdowns.
  const layout = await pdfToText(filePath, true);
  const employee = layout.match(/^\s*Your contributions\s+\$?([\d,]+\.\d{2})/m);
  const employer = layout.match(/^\s*Employer contributions\s+\$?([\d,]+\.\d{2})/m);

  const transactions: ParseResult["transactions"] = [];
  const pushContribution = (amount: string | undefined, kind: string) => {
    if (!amount) return;
    const amount_cents = cents(amount);
    if (amount_cents === 0) return;
    transactions.push(
      makeTx({
        date: covered_to,
        amount_cents,
        description: `TIAA ${kind} contribution`,
        account: ACCOUNT,
        institution: "TIAA",
        raw: { source: "tiaa-statement-summary", period: `${covered_from}/${covered_to}`, kind, amount },
      })
    );
  };
  pushContribution(employee?.[1], "employee");
  pushContribution(employer?.[1], "employer");

  return {
    transactions,
    balances: [{ date: statementDate, account: ACCOUNT, institution: "TIAA", balance_cents }],
    covered_from,
    covered_to,
  };
}
