# Bank of America

This workflow launches a headed Chrome persistent context through Playwright's
JavaScript API. The profile is named `finance-catchup`; the script never
exports cookies, credentials, or authentication tokens.

## Invocation

Run from the EasyMoney repository root:

```bash
bun .codex/skills/update-finance-data/scripts/bank-of-america.ts \
  --session finance-catchup \
  --output-dir "$HOME/Downloads/easymoney-imports/2026-08-12" \
  --checking-from 2026-06-01 \
  --savings-from 2026-05-26 \
  --card-from 2026-05-12 \
  --through 2026-08-13
```

Use `--dry-run` to validate already-staged Bank of America files without using
the browser. Normal runs are resumable and skip every valid existing artifact,
including statement files already staged under date-suffixed names.

The script owns the browser and controller for the entire run. Authentication
is retained in EasyMoney's local persistent profile between runs; there is no
Playwright CLI daemon, session registry, Unix socket, or browser endpoint.

## Authentication Pause

If authentication is required, personally enter credentials and complete MFA
or CAPTCHA in the browser opened by the still-running script. The workflow
continues after authentication and closes Chrome when validation completes.

## Outputs

The script saves explicit PII-free names in the selected output directory:

- Deposit activity: `bofa-checking-<from>-to-<through>.csv` and
  `bofa-savings-<from>-to-<through>.csv`.
- Credit-card activity: one current-transactions CSV plus one CSV for each
  statement cycle needed to cover the requested range.
- Statements: `bofa-<account-kind>-YYYY-MM-statement.pdf` for statement dates
  on or after that account's start date and on or before the through date.

Before and after browser work, every Bank of America artifact is checked for a
supported extension, nontrivial size, and CSV-text or PDF magic. File contents
are never printed. Valid existing artifacts are skipped, including checking
statements already staged with a date between the month and `-statement.pdf`.

## Verified Site Behavior

- Checking and savings activity use Activity, Filter, Custom date range,
  Apply, Download, Custom date range, and Microsoft Excel Format.
- Checking and savings CSVs are fetched directly from the page's authenticated
  transaction download form. The script discovers the live account token and
  form action in the DOM, overrides only the requested date range and CSV
  format, and does not persist or print the token.
- Credit-card activity has no custom date export. The script downloads current
  transactions and every available statement cycle whose end date falls in the
  requested range. It fetches each page-generated export target directly rather
  than navigating the browser to it.
- Opening each Statements section calls Bank of America's `gatherDocuments`
  JSON endpoint. The script uses the returned document IDs, dates, account
  display names, and live account tokens in memory to fetch PDFs directly from
  `docViewDownload`.

## Limitations

The account selector uses the observed product labels for Advantage Plus
checking, Advantage Savings, and Customized Cash Rewards. A renamed account or
a different Bank of America product may require a selector update. Live
account tokens are discovered dynamically inside the authenticated page and are
never logged, persisted, or documented.
