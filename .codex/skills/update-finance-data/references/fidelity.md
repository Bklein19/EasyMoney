# Fidelity Catch-Up

## Invocation

Run from the EasyMoney repository:

```sh
bun .codex/skills/update-finance-data/scripts/fidelity.ts \
  --from 2026-05-24 \
  --to 2026-08-13 \
  --output /private/tmp/easymoney-fidelity-catchup \
  --session fidelity-catchup
```

The script uses Playwright's JavaScript API and a local persistent Chrome
profile named `fidelity-catchup`, with no cookie or storage-state export. The
Bun process owns the browser for the complete run. Valid existing outputs are
skipped.

## Authentication Pause

The script opens Fidelity's public home page and follows the Portfolio control.
If Fidelity redirects to sign-in, complete credentials, MFA, and any CAPTCHA
directly in the headed browser. The same run waits and continues afterward.

## Outputs

- `fidelity-investment-activity-<from>-to-<to>.csv`
- `fidelity-retirement-activity-<from>-to-<to>.csv`
- `fidelity-investment-report-<yyyy-mm>.pdf` for completed statement months in the requested window

Each output is PII-free by filename. The script validates extension, minimum size, and CSV/PDF magic before accepting it. It also runs every PDF through EasyMoney's Fidelity investment-report parser and requires a parsed balance. Use `--validate-only` to recheck staged files without opening Fidelity.

## Completed Flow

1. Portfolio, then Activity & Orders.
2. Select the first brokerage/investment account or first retirement account by account-class text.
3. Choose Custom, apply the requested dates, open Download, and choose Download as CSV.
4. Portfolio, then Documents. Use the explicit Download Document control for each completed monthly statement.

## Limitations

- EasyMoney does not currently have a Fidelity activity CSV parser. Keep the CSVs as source exports; do not treat them as import-ready until a parser exists.
- No separate Investment Report control was available in the observed Personal documents view. Fidelity listed the monthly files as statements, but the live files parsed successfully with EasyMoney's Fidelity investment-report parser.
- EasyMoney's automatic investment-report routing still requires a legacy filename containing account digits. The PII-free files therefore need that parser selected explicitly until routing supports the PII-free convention; do not rename them to include account digits.
- Employer retirement statement generation was available, but it opened a short-lived browser blob instead of a normal download or authenticated PDF response. The reusable script does not yet claim or automate that PDF.
- Account selection intentionally uses account-class labels and never records account names, numbers, balances, or employer details.
