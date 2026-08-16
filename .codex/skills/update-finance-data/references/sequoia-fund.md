# Sequoia Fund

## Invocation

From the EasyMoney repository root:

```bash
bun .codex/skills/update-finance-data/scripts/sequoia-fund.ts
```

The script uses `npx --yes -p @playwright/cli@latest playwright-cli` and the persistent headed session `sequoia-fund-catchup`. It skips an existing output only after validating its extension, minimum size, and file signature. Use `--force` to re-download and revalidate every artifact.

## Authentication Pause

If the named session is not running, the script opens it at the Sequoia Fund account login. The user must enter credentials, complete MFA, and solve any CAPTCHA in that headed browser. The script exits with status 2 while authentication is required; rerun the same command after login.

The workflow does not save or print cookies, tokens, hidden account values, document identifiers, or signed document URLs.

## Verified Outputs

The fixed staging directory is `/private/tmp/easymoney-sequoia-fund-catchup`:

- `sequoia-fund-activity-2025-08-13-to-2026-08-13.csv`
- `sequoia-fund-2026-03-31.pdf`
- `sequoia-fund-2026-06-30.pdf`

The one-year activity export overlaps the required 2026-03-24 through 2026-08-13 window. The authenticated site offered quarterly statements for 2026-03-31 and 2026-06-30; both were downloaded. No later statement was available on 2026-08-13.

## Verified Workflow

- Activity: open History, require exactly one investment-account choice, select one year and all transaction types, then POST the page's CSV form directly inside the authenticated browser context.
- Statements: open Statements, locate each required quarterly date, open its transient document tab, and download the PDF through the same authenticated browser context.
- Each response is checked before saving. The completed local files are checked again for extension, size, and CSV/PDF signature.

## Limitations

- The activity page does not offer a custom date range, so the script downloads a one-year overlapping export.
- The current EasyMoney Sequoia parser supports statement PDFs, not the downloaded activity CSV. Keep the CSV as source data, but expect import preview to reject it until a Sequoia activity parser exists.
- The script is intentionally fixed to this catch-up window, output directory, one-account expectation, and the two statements that were available during verification.
