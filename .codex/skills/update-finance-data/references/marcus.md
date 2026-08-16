# Marcus Catch-Up

## Invocation

```sh
bun .codex/skills/update-finance-data/scripts/marcus.ts \
  --from 2026-01-01 \
  --to 2026-08-15 \
  --output /private/tmp/easymoney-marcus-catchup \
  --session marcus-catchup
```

The script uses Playwright's JavaScript API with a local persistent Chrome
profile. The Bun process owns the browser for the complete run. It never enters
credentials, exports browser state, or prints account data. Existing PDFs are
skipped only after the EasyMoney Marcus parser validates the PDF, its statement
period, activity rows, and ending balance. A clean run reports elapsed
milliseconds.

## Outputs

The staging directory contains one PII-free PDF per requested statement month:

`marcus-online-savings-statement-YYYY-MM.pdf`

Each PDF is checked for PDF magic and parsed with `server/app/importParsers/moneyParsers/marcus-statement-pdf.ts`. The workflow prefers authenticated document links and authenticated response downloads; it does not scrape statement contents into logs.

## Import Readiness

The PDFs are parser-ready, but automatic import routing is not currently ready with PII-free filenames. EasyMoney's Marcus filename matcher expects an account last-four segment. Keep these files in the staging directory and select the Marcus parser explicitly during import rather than adding account digits to filenames.

## Authentication And Gaps

If Marcus requires authentication, complete login and MFA in the browser opened
by the script; the same run waits and continues afterward. The script stops
when document controls are unavailable, when a response is not a PDF, or when
any requested month cannot be parser-validated. Direct document-request routing
still needs verification after scheduled maintenance ends. The implementation
fails closed rather than guessing among accounts.

Use `--validate-only` to validate staged PDFs without browser access. Use `--timing-only` to measure validation of the current staged set.
