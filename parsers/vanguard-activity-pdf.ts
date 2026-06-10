import { createHash } from "crypto"
import { getDocumentProxy, extractText } from "unpdf"

type ParseResult = {
  transactions: Array<{
    id: string
    date: string
    amount_cents: number
    description: string
    account: string
    institution: string
    raw: Record<string, unknown>
  }>
  balances: Array<{
    date: string
    account: string
    institution: string
    balance_cents: number
  }>
}

function toIsoDate(value: string): string {
  const [m, d, y] = value.trim().split("/").map(Number)
  return `${y.toString().padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

function parseAmountToCents(value: string): number {
  const cleaned = value.replace(/[$,\s]/g, "")
  const negative = cleaned.startsWith("-")
  const numeric = parseFloat(cleaned.replace(/^-/, ""))
  const cents = Math.round(numeric * 100)
  return negative ? -cents : cents
}

function makeId(rawRow: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(rawRow)).digest("hex")
}

export default async function parse(filePath: string): Promise<ParseResult> {
  const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(filePath).arrayBuffer()))
  const { totalPages, text: pageTexts } = await extractText(pdf)  // text is string[], one entry per page
  const pageText = pageTexts[0]  // page 1
  void pageText

  const accountMatch = pageTexts.join("\n").match(/Brokerage\s+-\s+([^\n*]+)/)
  const account = accountMatch ? accountMatch[1].trim() : "Brokerage"
  const institution = "Vanguard"
  const transactions: ParseResult["transactions"] = []

  for (let i = 0; i < totalPages; i++) {
    const lines = pageTexts[i]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    for (let j = 0; j < lines.length; j++) {
      const line = lines[j]
      const rowStart = line.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+/)
      if (!rowStart) continue

      let row = line
      while (j + 1 < lines.length && !/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+/.test(lines[j + 1]) && !/^Custom report created on:/.test(lines[j + 1]) && !/^Brokerage\s+-/.test(lines[j + 1]) && !/^Page \d+ of \d+/.test(lines[j + 1])) {
        j++
        row += " " + lines[j]
      }

      const amountMatch = row.match(/(-?\$[\d,]+(?:\.\d+)?|\$[\d,]+(?:\.\d+)?-)$/)
      if (!amountMatch) continue
      const amountText = amountMatch[1].endsWith("-") ? "-" + amountMatch[1].slice(0, -1) : amountMatch[1]
      const amount_cents = parseAmountToCents(amountText)

      const parts = row.split(/\s+/)
      const settlementDate = parts[0]
      const tradeDate = parts[1]
      const beforeAmount = row.slice(0, row.length - amountMatch[0].length).trim()
      const description = beforeAmount.replace(/^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}\/\d{1,2}\/\d{4}\s+/, "")

      const raw = {
        settlement_date: settlementDate,
        trade_date: tradeDate,
        row_text: row,
        amount: amountText,
      }

      transactions.push({
        id: makeId(raw),
        date: toIsoDate(settlementDate),
        amount_cents,
        description,
        account,
        institution,
        raw,
      })
    }
  }

  return { transactions, balances: [] }
}
