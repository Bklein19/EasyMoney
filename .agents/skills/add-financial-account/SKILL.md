---
name: add-financial-account
description: Add a new financial institution/account to the local money personal finance observatory by preserving raw downloads, implementing deterministic Bun/TypeScript parsers, rebuilding from imports/raw, and validating the ledger without one-off account hacks.
---

# Add Financial Account

Use this skill when adding a new bank, brokerage, retirement, or credit account to `/Users/example-user/src/money`.

## Guardrails

- Treat downloaded statements, activity exports, account numbers, cookies, and session URLs as private financial data.
- Do not access an institution website unless the user has explicitly logged in or provided the browser session for this task.
- Preserve raw source files. Do not hand-enter ledger rows when a statement or export can be parsed.
- Do not add one-off account hacks in rebuild, accounts, or UI code. Account support belongs in deterministic parser modules plus explicit alias/manual facts when needed.
- Do not touch unrelated dirty files. The repo often has statement downloads and parser work in progress from another thread.

## Recon

1. Inspect `AGENTS.md`, `package.json`, `parsers/`, `parsers/index.ts`, `src/types.ts`, `src/importer.ts`, and `src/rebuild.ts`.
2. Check `git status --short --branch` before editing and keep unrelated changes out of commits.
3. Search existing files before logging in or downloading anything:
   - `rg -n "<institution>|<known account label>|<export header>" .`
   - `find imports .playwright-cli -type f \( -iname "*.csv" -o -iname "*.pdf" -o -iname "*.html" \) -print`
4. Identify the source of truth:
   - Prefer full CSV/activity exports for transaction history when available.
   - Use statements for balances, statement-only cash flow summaries, or accounts where no activity export exists.
   - For retirement/brokerage accounts, expect both a high-priority activity export and lower-priority statements when the institution provides both.

## Download Workflow

Use headed Playwright when the task requires an authenticated website flow.

- Start a provider-specific headed persistent session, then let the user log in:
  - `bunx @playwright/cli -s=<institution> open <url> --headed --persistent --profile=.playwright-cli/<institution>-profile`
  - Do not collect, request, or store credentials. Wait for the user to say they are in.
- Once authorized, inventory all visible account/document areas before downloading:
  - account summary and account detail pages
  - statements/documents/eDocuments/message-center/tax-form tabs
  - activity/export/download pages
  - per-account and all-account filters
  - year, quarter, custom-date, and "all available" selectors
- For each account, try the maximum official export first. If a max-range CSV fails, retry smaller chunks and rely on statements for older history.
- Download every visible statement/document year and period, not just the latest list. Expand year selectors and pagination until there are no older visible rows.
- Record what the site exposes and any hard limits or failures, such as "statements up to 7 years", "CSV max 25 months", or "card 25-month export returned temporarily unavailable".
- Keep downloads in a provider-specific staging folder such as `imports/downloads/<institution>/`.
- Preserve original downloads before renaming, converting, or parsing.
- Rename copied source files with stable, descriptive names that include institution, account suffix or account type, and covered date when known.
- Do not scrape pages into custom JSON if CSV/PDF/HTML exports are available from the institution.
- Capture enough notes to reproduce the export filters: account, date range, settled vs pending, file type, and whether the export includes balances.
- Close headed sessions when finished:
  - `bunx @playwright/cli -s=<institution> close`

### Rough Authenticated Download Process

1. Open the institution in a headed persistent browser and wait for the user to log in.
2. Inventory the logged-in site before downloading:
   - account summary and account detail pages
   - activity/export/download pages
   - statements/documents/eDocuments/tax-center/message-center areas
   - all account, per-account, year, custom-date, pagination, and archive controls
3. Prefer parseable exports first:
   - Download CSV/QIF/OFX/HTML activity when available.
   - Use the largest reliable range first; if that fails, split by year or smaller chunks.
   - Record exact range limits the site enforces.
4. Still collect statements:
   - Statements often provide authoritative balances, older history, and account metadata missing from CSV exports.
   - Download as many statement periods as the site exposes, working backward through all year/archive selectors.
5. Preserve raw downloads immediately in `imports/downloads/<institution>/`, grouped by source type when useful:
   - `activity/` for CSV/OFX/etc.
   - `statements/` for PDFs or statement HTML
   - `documents/` for notices, tax forms, confirmations, or message-center files if relevant
6. Verify downloads before importing:
   - Hash files and check for accidental duplicates.
   - Extract CSV headers/date ranges and PDF text date ranges/balances.
   - Confirm filenames, parsed dates, and source text agree.
7. Only then implement or update deterministic parsers and import through `src/importer.ts`.

### Fragile Website Behaviors

- Do not assume a visible download URL or API endpoint uniquely identifies the requested document.
- If a shortcut API path returns duplicate hashes or wrong document text, switch to the real UI flow:
  - click the rendered row/control
  - capture the actual browser response/download
  - verify the downloaded file text matches the row label/date
- Some sites group statements by received date, not statement period. Use the rendered row label and extracted PDF period as the source of truth.
- Browser PDF viewer tabs can expose Chrome viewer HTML instead of the underlying PDF body. Prefer Playwright download events or response bodies from the institution request, then verify with `pdftotext`.
- Keep temporary Playwright scripts, cookies, state files, and response dumps out of commits; remove secret-bearing artifacts when no longer needed. Preserve only the actual source downloads needed for import/audit.

## Download Completeness Check

Before claiming the download is complete, answer these from the live site or downloaded inventory:

- Which accounts were visible, and which account types/suffixes were downloaded?
- What activity exports were downloaded, with exact covered ranges?
- What statements/documents were downloaded, with earliest and latest dates per account?
- Did any document categories exist outside statements, such as tax forms, notices, trade confirmations, or messages?
- Did the site expose older years through a separate selector, archive page, pagination, or per-account filter?
- Which attempted downloads failed or were rate-limited, and what fallback source covers that range?

Use careful language in the final answer: say "all visible/downloadable documents I found" unless a second pass through every document category confirms there are no hidden tabs or archives.

## Parser Implementation

Create provider-specific modules under `parsers/` and register them in `parsers/index.ts`.

- Export `meta: ParserMeta` and default `parse(filePath): Promise<ParseResult>`.
- Use Bun APIs and existing helpers from `parsers/_helpers.ts`.
- Matchers must be deterministic and mutually exclusive. Combine filename and short text/header samples when filenames are generic.
- Prefer exact CSV headers or provider-specific PDF text markers. Avoid broad matches like any filename containing `statement`.
- Emit canonical `ParsedTransaction` rows with `makeTx`.
- Use positive cents for credits and negative cents for debits.
- Set `kind: "activity-export"` and `priority: 100` for detailed transaction exports.
- Set `kind: "statement"` and `priority: 50` for statements.
- Return `covered_from` and `covered_to` for activity exports so rebuild can drop duplicated lower-priority statement activity by account/month.
- Emit balances from statements. Activity exports usually return no balances unless the export explicitly contains reliable dated balances.
- Preserve useful raw fields in `raw` for auditability, but do not include secrets beyond what already exists in the source file.

## Import And Rebuild

The app is provenance-first:

- `src/importer.ts` hashes a source file into `imports/raw/`, resolves a committed parser, validates parse success, then rebuilds.
- `src/rebuild.ts` parses every raw file and projects the ledger from source files plus manual facts.
- Parser ids in `parsers/index.ts` are the registry. There is no mutable parser DB to update manually.

Useful commands:

```bash
bun test
bun src/rebuild.ts --verify
bun src/rebuild.ts
bunx tsc --noEmit
```

If the repo later adds script aliases, prefer the normal repo scripts, but keep using Bun.

## Validation

Before committing parser changes:

1. Run parser-specific tests when present.
2. Run `bun test`.
3. Run `bun src/rebuild.ts --verify`.
4. Run `bunx tsc --noEmit`.
5. Spot-check counts and at least a few parsed transactions/balances against the raw source text.
6. Confirm `git diff` only contains the parser, tests, registry entry, and any intentionally added raw source files.

## No Samples Yet

If no provider sample exists locally and the user has not authorized a live download session:

- Do not implement a guessing parser.
- A safe scaffold is only acceptable if its matcher cannot match anything real until a sample-specific header or text marker is added.
- Prefer returning an exact implementation plan naming the files/functions to add once samples are available.

## Commit Discipline

For `/Users/example-user/src/money`, stay on `main` unless the user says otherwise. Commit logical changes after the acceptance commands pass. If a remote exists and its origin starts with `example-user`, push each commit to `main`; otherwise report that no push was possible.
