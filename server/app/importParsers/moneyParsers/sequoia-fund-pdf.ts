import type { ParseResult, ParserMeta } from "./types.ts";
import { pdfToText, cents, makeTx } from "./_helpers";
import {
  isSequoiaFundStatementFileName,
  sequoiaFundFileAccountIdentity,
  sequoiaFundSourceAccountName,
} from "../sequoiaFundIdentity.ts";

export const meta: ParserMeta = {
  id: "sequoia-fund-pdf",
  institution: "Sequoia Fund",
  kind: "statement",
  priority: 50,
  matches: ({ filename }) => isSequoiaFundStatementFileName(filename),
};

export function sequoiaFundStatementAccount(filePath: string, text = ""): string {
  const identity = sequoiaFundFileAccountIdentity(filePath);
  if (identity.kind === "last4") {
    const statementLast4 = text.match(/(?:account|fund account)(?:\s+(?:number|no\.?))?\s*[:#-]?\s*(?:x+|\*+|\u2022+)?\s*(\d{4})\b/i)?.[1];
    if (statementLast4 && statementLast4 !== identity.value) {
      throw new Error("Sequoia Fund statement account does not match its artifact identity");
    }
  }
  return sequoiaFundSourceAccountName(filePath);
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const text = await pdfToText(filePath);
  const account = sequoiaFundStatementAccount(filePath, text);

  // "MM/DD/YY through MM/DD/YY" or "MM/DD/YYYY through MM/DD/YYYY"
  const periodMatch = text.match(
    /(\d{2})\/(\d{2})\/(\d{2,4}) through (\d{2})\/(\d{2})\/(\d{2,4})/
  );
  if (!periodMatch) return { transactions: [], balances: [], covered_from: "", covered_to: "" };

  const toFullYear = (y: string) => (y.length === 2 ? (parseInt(y) < 50 ? "20" + y : "19" + y) : y);
  const covered_from = `${toFullYear(periodMatch[3]!)}-${periodMatch[1]}-${periodMatch[2]}`;
  const covered_to = `${toFullYear(periodMatch[6]!)}-${periodMatch[4]}-${periodMatch[5]}`;

  // ACTIVITY purchases — external money in (ACH / check). Reinvested distributions
  // (Cap Gain Rein, Income Reinvest) are investment returns, skipped.
  // `04/15/21 Shares Purchased -ACH    400.00 191.37    2.090   147.298`
  const transactions: ParseResult["transactions"] = [];
  const layoutText = await pdfToText(filePath, true);
  for (const line of layoutText.split("\n")) {
    const m = line.match(
      /^\s*(\d{2})\/(\d{2})\/(\d{2})\s+((?:Shares Purchased|Fund Purchase)[^.\d]*\d*)\s+([\d,]+\.\d{2})\s+[\d,]+\.\d{2}\s+[\d,.]+\s+[\d,.]+/
    );
    if (!m) continue;
    const date = `${toFullYear(m[3]!)}-${m[1]}-${m[2]}`;
    const description = m[4]!.trim();
    transactions.push(
      makeTx({
        date,
        amount_cents: cents(m[5]!),
        description,
        account,
        institution: "Sequoia Fund",
        raw: { type: "purchase", date, description, amount: m[5] },
      })
    );
  }

  // Balance: "$57,277.55\n" then shortly after "Market Value as of MM/DD"
  const balMatch = text.match(/\$([\d,]+\.\d{2})\s*\n[\s\S]{0,300}Market Value as of \d{2}\/\d{2}\/\d{2}/);
  const balances = balMatch
    ? [{ date: covered_to, account, institution: "Sequoia Fund", balance_cents: cents(balMatch[1]!) }]
    : [];

  return { transactions, balances, covered_from, covered_to };
}
