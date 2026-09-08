---
name: easymoney-data-sync
description: "Guide EasyMoney data catch-up runs and build, repair, or live-validate its institution connectors. Use for supported bank, brokerage, retirement, and credit-card downloads; staging and importing finance files; connector implementation or parity work; authenticated connector iteration; and final app-button readiness testing."
---

# EasyMoney Data Sync

## Choose The Mode

- For a user-driven finance-data catch-up, follow the workflow below and read
  `references/supported-institutions.md`.
- For connector implementation, repair, authenticated iteration, or readiness
  claims, read `references/connector-development.md` first. Its evidence gates
  are mandatory: offline success, live harness success, and final app-button
  success are different states.

## Core Rule

Do not automate bank logins, password entry, MFA, or sensitive account pages unless the user explicitly asks for interactive browser help and remains in control of credentials. Prefer a user-driven download checklist, then assist with file organization, EasyMoney import, and categorization.

For automated catch-up, the registered connectors under
`server/app/dataSync/institutions/` and the shared `server/app/dataSync/`
infrastructure are the only connector implementations. Do not add or revive
institution executables under this skill. Run the production connector from
the Import page, or use the production-backed development runner described in
`references/connector-development.md` while iterating.

## Catch-Up Workflow

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

## Browser Automation Contract

- In-codebase production connectors use the pinned Playwright JavaScript API
  under Bun. Do not add skill-local institution runners, Playwright CLI daemons,
  session registries, Unix-socket discovery, externally exposed CDP endpoints,
  or ad hoc cookie/token export to the product architecture.
- Computer Use's ordinary Google Chrome view cannot see or inspect Chrome
  instances launched by Playwright. During connector iteration, inspect the
  browser through the owning Playwright process, a purpose-built Playwright
  script, or Playwright CLI only when it genuinely owns or attaches to that
  session. A launch log is not proof that the user received a visible window.
- Launch through the shared in-codebase browser/session infrastructure. Each
  institution gets a PII-free profile name and a stable platform-specific
  profile directory outside the repository.
- The connector-owning Bun process owns the browser and controller for the whole
  run, waits while the user completes login/MFA/CAPTCHA, then closes the browser
  cleanly.
- Shared infrastructure checkpoints browser authentication state inside the
  institution's private profile and restores it on the next run. This preserves
  session state that Chrome's profile alone may discard; it does not justify a
  second skill-local browser implementation.
- Treat browser profiles and `.easymoney-auth-state.json` files as secrets. They live outside the repository, must never be committed, copied between users, or logged, and are owner-readable only on Unix-like systems. They contain session tokens, not usernames or passwords.
- Prefer `context.request` for authenticated artifact requests once the site contract is verified. Use native Playwright download events when the request contract is unclear or the site requires a browser gesture.
- Validate file signatures and the matching EasyMoney parser before reporting an artifact as ready. Never log credentials, cookies, tokens, account identifiers, document identifiers, signed URLs, or downloaded contents.

## File Handling

- Supported extensions: `.csv`, `.txt`, `.pdf`, `.html`, `.htm`.
- Keep one folder per catch-up run.
- Prefer filenames containing institution, account kind/last4 when known, and date range.
- If a parser currently relies on a specific filename pattern, use the pattern in `references/supported-institutions.md`.
- Never commit real downloaded financial files to the repo.

## Updating This Skill

When the user completes an institution download flow, add or update that institution's notes in `references/supported-institutions.md`:

- Login entrypoint, if useful.
- The menu path to exports/statements.
- Export format and date-range choices.
- Any filename required by the parser.
- Any account mapping gotchas observed in EasyMoney preview.
