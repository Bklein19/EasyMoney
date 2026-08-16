# TIAA Catch-Up

## Invocation

```sh
bun .codex/skills/update-finance-data/scripts/tiaa.ts \
  --from=2026-01-01 \
  --to=2026-08-16 \
  --output-dir=/private/tmp/easymoney-tiaa-catchup
```

The script uses Playwright's JavaScript API with a local persistent Chrome
profile named `tiaa-catchup`. The Bun process owns the browser and controller
for the entire run. Playwright storage state is checkpointed privately inside
that profile to preserve authentication between runs; it never stores credentials
or logs tokens or page contents. Existing parser-valid artifacts are skipped, so
interrupted runs can be resumed. Use `--validate-only` to validate staged files
without opening the browser.

Use `--statements-only` to retrieve or validate quarterly statements without
letting an unavailable activity export block that independent artifact path.

## Outputs

- One PII-free activity CSV named `tiaa-retirement-annuity-<from>-to-<to>.csv`.
- One PDF per completed quarter in the requested range, named `tiaa-<date>-retirement-q<quarter>-<year>-0000.pdf`. `0000` is a synthetic routing suffix, not an account number; it preserves EasyMoney's current statement filename matcher without storing account identifiers.

CSV files must have the native TIAA header beginning `Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission`. Every CSV is parsed with EasyMoney's TIAA activity parser. Every PDF is checked for PDF magic, the TIAA filename pattern, a parsed balance, and the TIAA statement parser's supported statement text.

## Live Flow

After login, the typed Playwright flow discovers TIAA's exact Quick Download
and Statements routes from the participant home page.

For activity, it selects every offered account, selects the requested calendar
year, enables `Download to CSV`, and saves the native browser attachment. TIAA
offers the current year and two prior calendar years, one year at a time; use
separate runs for separate years.

For statements, it selects the requested year, expands the Statements section,
finds the `RETIREMENT Qn/YYYY` row, opens its View popup, and retrieves the PDF
through the authenticated document-delivery URL. It does not assume account
names or expose account numbers, balances, transaction text, document IDs, or
response contents. Complete authentication, MFA, or CAPTCHA in the browser
opened by the waiting script if it reports `Authentication required`.

## Import Readiness And Gaps

Validated artifacts are ready for EasyMoney import and should be imported together so the activity export supplies transaction detail and quarterly statements supply balance anchors. The current implementation depends on TIAA continuing to expose discoverable activity and statement links and on the activity export retaining the documented header. It does not claim success when a requested quarter is absent, a download is HTML/login content, or a parser rejects the file.

## 2026-08-16 Verification

The saved authentication state was reused without another login. A live run
retrieved and parser-validated one current-year activity CSV plus Q1 and Q2 2026
statement PDFs in 34 seconds. A subsequent offline `--validate-only` pass
validated all three artifacts in 220 milliseconds.
