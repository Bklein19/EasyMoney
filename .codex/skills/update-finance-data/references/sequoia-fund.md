# Sequoia Fund

## Invocation

From the EasyMoney repository root:

```bash
bun .codex/skills/update-finance-data/scripts/sequoia-fund.ts
```

The script uses Playwright's JavaScript API with a persistent headed profile
named `sequoia-fund-catchup`. The Bun process owns the browser and controller
for the entire run. It skips an existing output only after validating its
extension, minimum size, and file signature. Use `--force` to re-download and
revalidate every artifact.

## Authentication Pause

If authentication is required, the user enters credentials, completes MFA, and
solves any CAPTCHA in the browser opened by the script. The same process waits
and continues after authentication.

The workflow does not save or print cookies, tokens, hidden account values, document identifiers, or signed document URLs.

## Verified Outputs

The fixed staging directory is `/private/tmp/easymoney-sequoia-fund-catchup`:

- `sequoia-fund-activity-2025-08-13-to-2026-08-13.csv`
- `sequoia-fund-2026-03-31.pdf`
- `sequoia-fund-2026-06-30.pdf`

The one-year activity export overlaps the required 2026-03-24 through 2026-08-13 window. The authenticated site offered quarterly statements for 2026-03-31 and 2026-06-30; both were downloaded. No later statement was available on 2026-08-13.

## Verified Workflow

- Activity: open History, treat every enabled nonempty account-dropdown entry as an export scope, select one year and all transaction types, then revalidate and POST each scope's CSV form sequentially inside the authenticated browser context.
- Statements: open Statements, locate each required quarterly date, open its transient document tab, and download the PDF through the same authenticated browser context.
- Each response is checked before saving. The completed local files are checked again for extension, size, and CSV/PDF signature.

## Limitations

- The activity page does not offer a custom date range, so the script downloads a one-year overlapping export.
- EasyMoney supports both the connector-generated activity CSVs and statement PDFs. Each scope filename carries the selected local account identity plus a PII-free stable scope hash; all files from the login map to that one account.
- The script is intentionally fixed to this catch-up window, output directory, one-account expectation, and the two statements that were available during verification.
