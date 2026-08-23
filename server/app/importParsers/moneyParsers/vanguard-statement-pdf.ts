import type { ParseResult, ParserMeta } from "./types.ts";
import { makeTx } from "./_helpers";
import { getDocumentProxy, extractText } from "unpdf";

export const meta: ParserMeta = {
  id: "vanguard-statement-pdf",
  institution: "Vanguard",
  kind: "statement",
  priority: 50,
  matches: ({ filename, sample }) =>
    /^\d{4}-\d{2}-\d{2}-(Brokerage|Roth-IRA|Trad-IRA)(?:-\d{4})?---.+\.pdf$/.test(filename) ||
    /^vanguard-\d{4}-\d{4}-\d{2}-\d{2}-statement\.pdf$/.test(filename) ||
    // Generically-named statements (statement-4.pdf etc.) — disambiguate by content.
    (/^statement-\d+\.pdf$/.test(filename) && /Vanguard Brokerage Services/.test(sample)),
};

function parseStatementDate(text: string): string {
  const d = text.match(
    /([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4}),\s+(?:monthly transaction|quarter-to-date|year-to-date)\s+statement/
  );
  if (!d) throw new Error("Could not find statement date");
  const months: Record<string, string> = {
    January: "01", February: "02", March: "03", April: "04", May: "05", June: "06",
    July: "07", August: "08", September: "09", October: "10", November: "11", December: "12",
  };
  return `${d[3]}-${months[d[1]!]}-${String(Number(d[2])).padStart(2, "0")}`;
}

function parseMd(value: string, year: number): string {
  const [m, d] = value.split("/").map(Number);
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseAmountToCents(value: string): number {
  const cleaned = value.replace(/[$,\s]/g, "");
  const negative = cleaned.startsWith("-");
  const c = Math.round(parseFloat(cleaned.replace(/^-/, "")) * 100);
  return negative ? -c : c;
}

export function parseVanguardAccountHolder(text: string): string | null {
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  const accountIndex = lines.findIndex(line =>
    /(Individual brokerage account|Roth IRA brokerage account|Traditional IRA brokerage account)[—-](?:X{4}\d{4}|\d{4,})/i.test(line)
  );
  if (accountIndex <= 0) return null;
  const candidate = lines[accountIndex - 1]!.replace(/\s+/g, " ").trim();
  const words = candidate.split(" ");
  if (words.length < 2 || words.length > 8 || candidate.length > 100) return null;
  if (!/^[\p{L}][\p{L} .,'’-]+$/u.test(candidate)) return null;
  if (/vanguard|statement|account|portfolio|services/i.test(candidate)) return null;
  return candidate;
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
  const { text: pageTexts } = await extractText(pdf);
  const allText = pageTexts.join("\n");
  const statementDate = parseStatementDate(allText);
  const year = Number(statementDate.slice(0, 4));

  const accountTypeMatch =
    allText.match(
      /(Individual brokerage account|Roth IRA brokerage account|Traditional IRA brokerage account)[—-](X{4}\d{4}|\d{4,})/
    ) ??
    allText.match(
      /(Individual brokerage account|Roth IRA brokerage account|Traditional IRA brokerage account)[\s\S]{0,120}?Vanguard Brokerage Account[—-](X{4}\d{4}|\d{4,})/
    );
  const accountType = accountTypeMatch ? accountTypeMatch[1]! : "Individual brokerage account";
  const accountSuffix = accountTypeMatch
    ? `XXXX${accountTypeMatch[2]!.slice(-4)}`
    : null;
  const account = accountSuffix ? `${accountType}-${accountSuffix}` : accountType;
  const accountHolder = parseVanguardAccountHolder(allText);
  const institution = "Vanguard";

  const balances: ParseResult["balances"] = [];
  const escapedType = accountType.replace(/[.*+?^()|[\]{}]/g, "\\$&");
  const balanceMatch =
    allText.match(
      new RegExp(escapedType + "\\s+\\$[\\d,]+\\.\\d{2}\\s+\\$(\\d[\\d,]*\\.\\d{2})")
    ) ??
    allText.match(/\$(\d[\d,]*\.\d{2})\s+Total account value as of [A-Z][a-z]+ \d{1,2}, \d{4}/);
  if (balanceMatch) {
    balances.push({
      date: statementDate,
      account,
      institution,
      ...(accountHolder ? { account_holder: accountHolder } : {}),
      balance_cents: parseAmountToCents(`$${balanceMatch[1]}`),
    });
  }

  const transactions: ParseResult["transactions"] = [];
  const txSectionMatch = allText.match(
    /Completed transactions([\s\S]*?)(?:If you had an adjustment|Electronic delivery and mail preferences|\f|$)/
  );
  if (txSectionMatch) {
    const lines = txSectionMatch[1]!.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!/^\d{2}\/\d{2}\s+\d{2}\/\d{2}\s+/.test(line)) continue;
      let row = line;
      while (i + 1 < lines.length && !/^\d{2}\/\d{2}\s+\d{2}\/\d{2}\s+/.test(lines[i + 1]!)) {
        i++;
        row += " " + lines[i];
      }
      let m = row.match(/^(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(.+?)\s+(-?\$?[\d,]+\.\d{2})$/);
      let description: string;
      if (m) {
        description = m[3]!.trim();
      } else {
        // Conversion rows have continuation lines AFTER the amount, so the amount
        // sits at the end of the first line rather than the whole row.
        m = line.match(/^(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(.+?)\s+(-?\$?[\d,]+\.\d{2})$/);
        if (!m) continue;
        description = (m[3]!.trim() + " " + row.slice(line.length).trim()).trim();
      }
      transactions.push(
        makeTx({
          date: parseMd(m[1]!, year),
          amount_cents: parseAmountToCents(m[4]!),
          description,
          account,
          institution,
          ...(accountHolder ? { account_holder: accountHolder } : {}),
          raw: { settlement: m[1], trade: m[2], row },
        })
      );
    }
  }

  const covered_from = transactions.length ? transactions.map((t) => t.date).sort()[0]! : statementDate;
  const covered_to = statementDate;
  return { transactions, balances, covered_from, covered_to };
}
