# Vanguard Catch-Up

This workflow was verified against Vanguard's authenticated site on 2026-08-13. It uses Playwright's JavaScript API with a local persistent profile named `vanguard-catchup` and never exports cookies, tokens, credentials, or storage state.

## Run

From the EasyMoney repository:

```bash
bun .codex/skills/update-finance-data/scripts/vanguard.ts
```

Optional overrides:

```bash
bun .codex/skills/update-finance-data/scripts/vanguard.ts \
  --through=2026-08-13 \
  --output-dir="$HOME/Downloads/easymoney-imports/2026-08-12"
```

The Bun process owns the headed Chrome context for the complete workflow. There
is no Playwright CLI daemon or socket. Existing artifacts are skipped only
after extension, size, file signature/shape, and statement-parser validation
succeed.

Use a separate PII-free account-set label and persistent session when the same
EasyMoney database contains more than one Vanguard login:

```bash
bun .codex/skills/update-finance-data/scripts/vanguard.ts \
  --session=vanguard-account-2-catchup \
  --account-set=account-2 \
  --through=2026-08-15 \
  --output-dir="$HOME/Downloads/easymoney-imports/2026-08-12"
```

The account-set label is included in filenames so one login cannot overwrite
another login's exports. It must be kebab-case and must not contain a holder
name or account number.

## Authentication Pause

If authentication is required, the script keeps its headed Chrome context open
while the user completes login, MFA, and any CAPTCHA. It then continues the
same run. Do not enter credentials through automation or export browser state.

## Verified Outputs

The assigned run writes these PII-free names under `~/Downloads/easymoney-imports/2026-08-12`:

- `vanguard-brokerage-2026-05-25-to-2026-08-13-activity.csv`
- `vanguard-roth-ira-current-2026-05-25-to-2026-08-13-activity.csv`
- `2026-06-30-Brokerage---current.pdf`
- `2026-06-30-Roth-IRA---current.pdf`
- `2026-07-31-Brokerage---current.pdf`
- `2026-07-31-Roth-IRA---current.pdf`

The activity files are separate current-account CSV exports. The statement files are separate account statements, not consolidated statements. The script matches statement rows by date and generic account type, never by account digits or holder name.

## Account Mapping

EasyMoney has four active Vanguard investment identities for this catch-up. The live Vanguard Activity and Download Center selectors expose only two current accounts: one brokerage account and one Roth IRA.

- Current brokerage: overlap starts `2026-05-25`; activity CSV and June/July statements were retrieved.
- Current Roth IRA: overlap starts `2026-05-25`; activity CSV and June/July statements were retrieved.
- Legacy Roth IRA: overlap starts `2026-05-24`; it is not selectable in Activity or Download Center, and Statements shows no separate document after May 2026.
- Legacy traditional IRA: overlap starts `2026-04-23`; it is not selectable in Activity or Download Center, and Statements shows no document after April 2026.

Do not map an all-account export to either legacy identity. The current Vanguard activity PDF produced by browser printing is a consolidated/current-page layout, and the existing `vanguard-activity-pdf` parser does not recognize its coverage or transaction rows. The workflow therefore does not stage printable activity PDFs or all-account exports.

## Import Limitations

- EasyMoney's current automatic Vanguard activity parser targets the older transaction-history PDF shape. The current Vanguard CSV exports are preserved source files but do not auto-resolve to that parser; review/import support is required before committing them.
- The four statement PDFs match the existing PII-free filename pattern and were verified with the real Vanguard statement parser. Each produced transactions and one balance record.
- Vanguard's authenticated transaction-history API returns JSON used by the page, not a downloadable parser-compatible activity document. Direct API download was therefore not used.
- If Vanguard exposes a different number of current download-account rows, removes a required statement row, or changes generic controls, the script fails instead of guessing or creating a consolidated mapping.
