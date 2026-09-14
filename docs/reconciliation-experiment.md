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

## First production validation gate

The reusable `validateStatementTotals` helper checks integer-cent printed arithmetic and separately compares parsed credits and debits. The Wells credit-card parser now supplies these totals. Touching post-date/reference columns and card-prefixed refund rows are supported. A recognized but incomplete summary fails closed; absent/unsupported summaries do not claim validation success.

Passing evidence is retained as balance metadata, never synthesized into transaction rows. The production adapter preserves it. Manual import preview parses before saving facts; connector artifact validation invokes the same adapter; automatic parser refresh catches parse failures and retains prior facts. Safe failure codes contain no account IDs, totals or document contents. No user approval can bypass this parser failure.

Wells statement-validation progress distinguishes `statementTotalsValidation: passed` from `unavailable`; `parserValidated` alone does not mean statement totals reconciled. The existing error UI is used, with no new dashboard or user decision for a parser defect.

This first gate covers supported Wells credit-card statements, not every parser. Deposit statements, other institutions, and investment roll-forward checks require their own explicit printed evidence extraction. Cross-file ledger reconciliation remains diagnostic-only, and is not an import blocker.

No live corrections or product UI changes are included. The retained-source replay is local-file validation, not a fresh connector login or user app-button test. Do not launch against a live database simply to demonstrate this change: changed parser fingerprints can start automatic refresh; review the candidate ledger first.

Validation gate acceptance: focused regression tests, the full 730-test suite, TypeScript compiler, lint and client build pass. The normal Electrobun prepare/build attempts stalled and were stopped; desktop packaging acceptance remains outstanding. This is local-branch implementation evidence, not a production rollout claim.
