import type { ParseResult, ValidationResult, ValidationError } from "./types";

export function validate(result: ParseResult): ValidationResult {
  const errors: ValidationError[] = [];

  for (let i = 0; i < result.transactions.length; i++) {
    const t = result.transactions[i]!;

    if (!t.date || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) {
      errors.push({ field: "date", message: `Invalid date: ${t.date}`, row: i });
    }
    if (typeof t.amount_cents !== "number" || !Number.isInteger(t.amount_cents)) {
      errors.push({ field: "amount_cents", message: `amount_cents must be an integer`, row: i });
    }
    if (!t.description?.trim()) {
      errors.push({ field: "description", message: "Empty description", row: i });
    }
    if (!t.account?.trim()) {
      errors.push({ field: "account", message: "Missing account", row: i });
    }
    if (!t.institution?.trim()) {
      errors.push({ field: "institution", message: "Missing institution", row: i });
    }
    if (!t.id?.trim()) {
      errors.push({ field: "id", message: "Missing id", row: i });
    }
  }

  for (let i = 0; i < result.balances.length; i++) {
    const b = result.balances[i]!;

    if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
      errors.push({ field: "date", message: `Invalid balance date: ${b.date}`, row: i });
    }
    if (typeof b.balance_cents !== "number" || !Number.isInteger(b.balance_cents)) {
      errors.push({ field: "balance_cents", message: "balance_cents must be an integer", row: i });
    }
  }

  // Warn if zero rows parsed but don't fail — could be a valid empty file
  if (result.transactions.length === 0 && result.balances.length === 0) {
    errors.push({ field: "_", message: "Parser produced no transactions and no balances" });
  }

  return { ok: errors.length === 0, errors };
}
