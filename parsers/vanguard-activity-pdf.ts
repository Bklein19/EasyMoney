import type { ParseResult, ParserMeta } from "../src/types";
import { makeTx } from "./_helpers";
import { getDocumentProxy, extractText } from "unpdf";

export const meta: ParserMeta = {
  id: "vanguard-activity-pdf",
  institution: "Vanguard",
  kind: "activity-export",
  priority: 100,
  matches: ({ filename }) => filename === "customActivityReport.pdf",
};

function parseAmountToCents(value: string): number {
  const cleaned = value.replace(/[$,\s]/g, "");
  const negative = cleaned.startsWith("-");
  const c = Math.round(parseFloat(cleaned.replace(/^-/, "")) * 100);
  return negative ? -c : c;
}

function toIsoDate(value: string): string {
  const [m, d, y] = value.split("/").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
  const { text: pageTexts } = await extractText(pdf);
  const allText = pageTexts.join("\n");
  const institution = "Vanguard";

  const accountMatch = allText.match(/Brokerage\s+-\s+(\d+)/);
  const account = accountMatch ? `Brokerage - ${accountMatch[1]}` : "Brokerage";

  const coverageMatch = allText.match(
    /This report only includes transactions that were settled from:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+to\s+(\d{1,2}\/\d{1,2}\/\d{4})\./
  );
  const covered_from = coverageMatch ? toIsoDate(coverageMatch[1]!) : "1900-01-01";
  const covered_to = coverageMatch ? toIsoDate(coverageMatch[2]!) : "1900-01-01";

  const transactions: ParseResult["transactions"] = [];
  const dateLineRegex = /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(.*)$/;
  const amountRegex = /(-?\$[\d,]+\.\d{4})$/;

  for (const page of pageTexts) {
    const lines = page.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const start = lines[i]!.match(dateLineRegex);
      if (!start) continue;

      let row = `${start[1]} ${start[2]} ${start[3]}`;
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (dateLineRegex.test(next)) break;
        if (/^Custom report created on:/.test(next)) break;
        if (/^This report only includes transactions/.test(next)) break;
        if (/^Brokerage\s+-/.test(next)) break;
        if (/^Page \d+ of \d+/.test(next)) break;
        row += ` ${next}`;
        i++;
      }

      const amountMatch = row.match(amountRegex);
      if (!amountMatch) continue;

      const description = row
        .replace(/^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}\/\d{1,2}\/\d{4}\s+/, "")
        .replace(/\s+-?\$[\d,]+\.\d{4}$/, "")
        .trim();

      transactions.push(
        makeTx({
          date: toIsoDate(start[1]!),
          amount_cents: parseAmountToCents(amountMatch[1]!),
          description,
          account,
          institution,
          raw: { row },
        })
      );
    }
  }

  return { transactions, balances: [], covered_from, covered_to };
}
