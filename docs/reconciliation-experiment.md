# Read-only reconciliation experiment

Run locally with Bun:

```sh
umask 077
bun scripts/reconcile-evidence.ts /absolute/path/to/database.sqlite 2026-01-01 2026-08-31 > /private/tmp/reconciliation.json
```

The command opens SQLite read-only, enables query-only mode, and reads in one transaction. It does not import application database initialization, migrate, refresh parsers, rebuild, connect to institutions, or launch the app. Reports contain private financial information: do not commit them.

## What it tests

- For checking, savings and credit: closing statement balance minus previous statement balance equals signed ledger transactions after the opening date through the closing date, in integer cents.
- Repeated identical statement balances provide evidence, not additional balances. Disagreeing balances block arithmetic.
- Coverage requires declared statement periods for an unambiguously single-source-account document. Observed transaction date ranges do not prove completeness.
- Windows are selected by closing date. The first may begin before the requested start. Trailing days after the last statement are shown as unverified coverage, not inferred missing transactions.
- Investments are explicitly unsupported for cash-flow reconciliation: market movement needs a separate statement roll-forward model.

## Interpretation

`balanced` means the arithmetic agrees, not that every transaction is independently verified. Offsetting errors can cancel. Statement balances and periods are still parser-derived; inspect printed totals to independently corroborate mismatches. Posting/trade-date differences can create boundary mismatches. Closed or not-yet-open accounts can have expected gaps; this prototype does not know lifecycle dates and deliberately reports them without claiming files are missing.

An initial local trial found both many exactly balanced windows and genuine parser omissions corroborated by a retained statement. This is worth pursuing, but not as a universal green confidence badge.

## Next experiment

1. Preserve printed opening balance, closing balance, total credits and total debits as **validation evidence**, never ledger transactions.
2. Check printed statement arithmetic, parsed row totals against printed totals, then ledger totals against the same statement period. These distinguish parser loss from ledger matching loss.
3. Preserve posted dates alongside economic dates for statement-window reconciliation.
4. Repair and regression-test demonstrated omissions before applying a reviewed parser refresh.
5. Improve account-scoped coverage and lifecycle metadata; distinguish missing statements from unverified period metadata and a period not yet issued.
6. Reconcile investment statements with explicit contributions, withdrawals, income, fees and market movement. Do not infer missing transactions from valuation change.

This branch is an experiment only. No live corrections or product UI changes are included.
