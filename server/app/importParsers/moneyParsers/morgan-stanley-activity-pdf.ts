import type { ParseResult, ParserMeta } from "./types.ts";
import { makeTx } from "./_helpers";
import { getDocumentProxy, extractText } from "unpdf";

export const meta: ParserMeta = {
  id: "morgan-stanley-activity-pdf",
  institution: "Morgan Stanley",
  kind: "activity-export",
  // Above statement (50): for months both cover, the full activity export wins
  // the transactions; the statement keeps balances + its unique security transfers.
  priority: 100,
  matches: ({ filename }) => filename === "AllActivity.pdf",
};

function toIsoDate(mmddyyyy: string): string {
  const [mm, dd, yyyy] = mmddyyyy.split("/");
  return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
}

function parseAmountToCents(value: string): number {
  return Math.round(parseFloat(value.replace(/,/g, "")) * 100);
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
  const { totalPages, text: pageTexts } = await extractText(pdf);
  const pageText = pageTexts[0] ?? "";

  const accountMatch = pageText.match(/Account Activity for\s+(.+?)\s+-\s+(.+?)\s+-\s+(\d{4})\s+from/);
  const owner = accountMatch?.[1]?.trim() || "";
  const accountName = accountMatch?.[2]?.trim() || "";
  const accountNumber = accountMatch?.[3]?.trim() || "";
  const account = `${accountName} - ${accountNumber}`;

  const transactions: ParseResult["transactions"] = [];

  for (let i = 0; i < totalPages; i++) {
    const lines = (pageTexts[i] || "").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!/^\d{2}\/\d{2}\/\d{4}\s+\d{2}\/\d{2}\/\d{4}\s+/.test(trimmed)) continue;
      const amountMatch = trimmed.match(/(-?[\d,]+\.\d{2})\s*$/);
      if (!amountMatch) continue;
      const amount = amountMatch[1]!;
      const withoutAmount = trimmed.slice(0, amountMatch.index).trim();
      const withoutTrailingNums = withoutAmount.replace(/\s+[-\d,]+\.\d+\s+[-\d,]+\.\d+$/, "");
      const parts = withoutTrailingNums.split(/\s+/);
      const date = parts[0]!;
      const rest = parts.slice(2).join(" ");
      transactions.push(
        makeTx({
          date: toIsoDate(date),
          amount_cents: parseAmountToCents(amount),
          description: rest,
          account,
          institution: "Morgan Stanley",
          raw: { line: trimmed, owner, accountName, accountNumber },
        })
      );
    }
  }

  return { transactions, balances: [] };
}
