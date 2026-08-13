---
name: update-finance-data
description: "Guide EasyMoney data catch-up runs: plan a safe user-driven tour through supported bank, brokerage, retirement, and credit-card sites; download recent CSV/PDF/HTML activity or statements; stage files for EasyMoney import; bulk import them; then run transaction review and categorization. Use when the user asks to update stale personal finance data, download recent bank data, navigate supported institution sites, prepare import files, or recover the import/categorization workflow after data is months out of date."
---

# Update Finance Data

## Core Rule

Do not automate bank logins, password entry, MFA, or sensitive account pages unless the user explicitly asks for interactive browser help and remains in control of credentials. Prefer a user-driven download checklist, then assist with file organization, EasyMoney import, and categorization.

Treat information visible after sign-in as private working data. Do not copy account-holder names, balances, full or partial account numbers, transaction descriptions, confirmation numbers, or authenticated URLs into this skill, repository documentation, filenames, commits, or chat summaries. When recording a verified workflow, use generic account kinds and placeholders such as `1234`.

## Workflow

1. Establish the catch-up window.
   - Ask or infer the last good import date from EasyMoney import history.
   - Prefer overlapping exports. The app dedupes overlapping activity files; avoiding gaps matters more than avoiding overlap.
   - Download statements for balance history when available, and activity exports for transaction detail.

2. Create a staging folder.
   - Use a dated folder such as `~/Downloads/easymoney-imports/YYYY-MM-DD`.
   - Keep original downloads, but rename copies when a parser expects or benefits from recognizable names.
   - Do not edit financial file contents unless the user explicitly asks and the change is documented.

3. Use the supported-institutions reference.
   - Read `references/supported-institutions.md` before advising what to download.
   - Treat exact website click paths as mutable. If the current site differs, record the updated path in the reference.
   - Record only stable navigation labels, export options, and parser-relevant behavior. Scrub all data observed in authenticated pages.

4. Import into EasyMoney.
   - Open `/import`.
   - Drop the whole staging folder or all staged files together.
   - Resolve account mappings explicitly when the preview asks.
   - Commit import facts before categorization. Do not categorize during parser/import work.

5. Reconcile.
   - Check import history for every staged file.
   - Check accounts/net worth for obvious missing balances.
   - Search transactions for the newest expected activity date by major account.

6. Categorize.
   - Open `/transactions/review`.
   - Sort by Money for high-dollar catch-up, Count for repetitive merchants.
   - Use "Do the rest with AI" only after reviewing category descriptions and obvious transfer/noise categories.
   - Apply batches, use undo immediately if a batch is clearly wrong, then review remaining uncategorized merchant groups.

## Download Strategy

- Bank/credit-card accounts: activity CSVs are usually the best transaction source; monthly statements are useful for balance anchors when parsers support them.
- Brokerages/retirement: statements often carry balances that activity exports do not; activity exports are still needed for contribution/transfer detail.
- Consolidated statements are allowed when parsers support them, but account mapping must be reviewed carefully.
- If a site only offers a custom date range, use last-good-import-date minus 7 days through today.
- If a site offers "since last statement" only, also download the latest full monthly/quarterly statement.

## File Handling

- Supported extensions: `.csv`, `.txt`, `.pdf`, `.html`, `.htm`.
- Keep one folder per catch-up run.
- Prefer filenames containing institution, account kind/last4 when known, and date range.
- If a parser currently relies on a specific filename pattern, use the pattern in `references/supported-institutions.md`.
- Never commit real downloaded financial files to the repo.
- Keep downloaded files outside the repository. Verify their names and locations without printing or documenting their contents.

## Updating This Skill

When the user completes an institution download flow, add or update that institution's notes in `references/supported-institutions.md`:

- Login entrypoint, if useful.
- The menu path to exports/statements.
- Export format and date-range choices.
- Any filename required by the parser.
- Any account mapping gotchas observed in EasyMoney preview.

Before committing a skill update, search the diff for names, balances, account identifiers, transaction text, confirmation identifiers, and authenticated query strings. Replace any such values with generic descriptions or placeholders.
