# TIAA Catch-Up

## Invocation

```sh
bun .codex/skills/update-finance-data/scripts/tiaa.ts \
  --from=2026-01-01 \
  --to=2026-08-15 \
  --output-dir=/private/tmp/easymoney-tiaa-catchup
```

The script uses the existing `tiaa-catchup` headed persistent session and current `npx playwright@latest cli` for session validation. It never exports cookies, storage state, credentials, tokens, or page contents. Existing parser-valid artifacts are skipped, so interrupted runs can be resumed. Use `--validate-only` to validate staged files without opening the browser.

## Outputs

- One PII-free activity CSV named `tiaa-retirement-annuity-<from>-to-<to>.csv`.
- One PDF per completed quarter in the requested range, named `tiaa-<date>-retirement-q<quarter>-<year>-0000.pdf`. `0000` is a synthetic routing suffix, not an account number; it preserves EasyMoney's current statement filename matcher without storing account identifiers.

CSV files must have the native TIAA header beginning `Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission`. Every CSV is parsed with EasyMoney's TIAA activity parser. Every PDF is checked for PDF magic, the TIAA filename pattern, a parsed balance, and the TIAA statement parser's supported statement text.

## Live Flow

After login, the browser program discovers the current TIAA activity/transaction/history export and statement/document links, then uses authenticated page requests where possible. It does not assume account names or expose account numbers, balances, transaction text, or response contents. Complete authentication, MFA, or CAPTCHA in the headed session if the script reports `Authentication required`.

## Import Readiness And Gaps

Validated artifacts are ready for EasyMoney import and should be imported together so the activity export supplies transaction detail and quarterly statements supply balance anchors. The current implementation depends on TIAA continuing to expose discoverable activity and statement links and on the activity export retaining the documented header. It does not claim success when a requested quarter is absent, a download is HTML/login content, or a parser rejects the file.

## 2026-08-15 Run Gap

The authenticated participant session was reachable and navigation succeeded. The transaction-view page exposed one generic form at `/app/mytiaatransactionview/`; its authenticated request returned HTML rather than the documented CSV, and the visible Download/CSV interaction did not emit a file download. No parser-valid activity export was produced. Statement retrieval was not reached successfully, so both requested quarterly PDFs remain unavailable and unvalidated.
