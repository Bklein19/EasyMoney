# EasyMoney

EasyMoney is a local-first personal finance app for importing bank, credit card, and investment files into a source-fact ledger, then reviewing transactions, accounts, budgets, net worth, performance, savings rate, and analytics from materialized read models.

## Desktop App

EasyMoney is packaged with Electrobun `2.0.1`. Electrobun RPC is used only as the transport between the webview and Bun main process: the existing tRPC router, validation, error shapes, and React Query integration remain unchanged. Browser development keeps the HTTP tRPC transport as a fallback.

The repository uses Bun for installation, scripts, tests, frontend bundling, the Electrobun CLI bootstrap, and the packaged main process. Do not invoke the Electrobun package's `node` shebang directly; the checked-in launcher runs it explicitly with Bun.

```bash
bun install
bun run dev              # one-shot build and open; rerun explicitly after changes
bun run dev:watch        # optional full rebuild/relaunch watcher (not HMR)
bun run dev:web          # optional browser-only development server
bun run build            # stable Electrobun package and update artifact
```

Desktop builds use the operating system webview rather than bundling Chromium. The cancellable institution-sync worker is compiled into the application during Electrobun's pre-build hook, so sync jobs do not depend on repository source files after packaging.

The stable build produces a native package for the host operating system. macOS uses WebKit, Windows uses WebView2, and Linux uses GTK 3 with WebKitGTK 4.1. Linux installations therefore require the distribution packages that provide `libwebkit2gtk-4.1` and `libayatana-appindicator3` (for example, `libwebkit2gtk-4.1-0` and `libayatana-appindicator3-1` on current Debian/Ubuntu releases). Google Chrome is required only for the optional institution-sync browser automation.

Desktop builds store their database and local environment file under Electrobun's channel-specific user-data directory. On first launch, an existing `~/src/EasyMoney/data/easymoney.sqlite` database and `~/src/EasyMoney/.env.local` are copied there as a consistent local snapshot. If an earlier launch already created a provably pristine database, recovery is published to a separate sibling database and selected without replacing the original SQLite file or its journal. Development and installed launches use the same channel data path; `EASYMONEY_LEGACY_DB_PATH` and `EASYMONEY_LEGACY_ENV_PATH` can select another migration source, while explicit `EASYMONEY_DB_PATH` and `EASYMONEY_ENV_PATH` overrides remain untouched.

## Features

- Import CSV, PDF, TXT, and HTML exports from supported institutions.
- Preview imports with parser matching, account mapping, duplicate detection, and warnings before commit.
- Store raw import files and parsed source facts as the durable source of truth.
- Rebuild materialized transactions and balances deterministically from committed source facts.
- Categorize transactions separately from imported facts so notes and categories survive rebuilds.
- Review accounts, transactions, budgets, net worth, performance, savings rate, and spending analytics.
- Keep app data local on the machine.

## Import Model

Imports are intentionally separate from categorization.

- Parsers parse files into source transactions, source balances, and source account context.
- Import preview lets you confirm account mappings and inspect duplicate or parser warnings.
- Import commit saves confirmed source facts and materializes app read models.
- Categorization happens later from the Transactions UI and is stored as user annotation data.
- Unimport marks an import inactive and rebuilds from the remaining active source facts.

This model is meant to handle overlapping activity exports without dropping real same-day duplicate purchases.

## Import Parser Coverage

Parsers try to extract durable source facts plus account context when the file format exposes it. Account number or suffix means the parser can infer a source-account identifier such as a full account number, masked number, or last four digits for account matching. Today that identifier is usually folded into the parsed account name; the import model is being extended toward first-class account-number metadata.

| Institution / source | File types | Transactions | Balances | Account name | Account holder | Account number / suffix |
| --- | --- | --- | --- | --- | --- | --- |
| American Express | CSV activity | Yes | No | No | No | No |
| Apple Card | CSV activity | Yes | No | No | No | No |
| Bank of America | CSV activity, PDF statements | Yes | Yes | Yes | No | Last four from filename or statement |
| Capital One | CSV activity | Yes | No | No | No | No |
| Chase | CSV activity | Yes | No | No | No | No |
| Citi | CSV activity | Yes | No | No | No | No |
| Fidelity 401(k) / NetBenefits | HTML/PDF statements | Yes | Yes | Yes | No | No |
| Fidelity portfolio / investment reports | PDF statements | Yes | Yes | Yes | Limited, format-specific | Full or formatted account number |
| Marcus | PDF statements | Yes | Yes | Yes | No | Last four from filename or statement |
| Merrill | CSV activity, PDF CMA statements | Yes | Yes | Yes | No | CSV account number or statement account number |
| Morgan Stanley | PDF activity, PDF statements | Yes | Yes | Yes | Yes for activity exports | Full or last-four statement/account number |
| Robinhood | CSV banking, PDF statements | Yes | Yes for statements | Yes | Yes for personal statement headings | Last four from statement account number |
| Sequoia Fund | CSV activity, PDF statements | Yes | Yes | Fixed fund account | No | Selector suffix when present |
| TIAA | CSV activity, PDF statements | Yes | Yes | Fixed retirement account | No | No |
| Vanguard | PDF activity, PDF statements | Yes | Yes | Yes | No | Masked suffix when present |
| Wells Fargo | CSV activity, PDF statements | Yes | Yes for statements | Yes when filename/statement identifies it | No | Last four from filename or statement |
| Custom CSV mapping | CSV activity | Yes | No | User-selected or mapped | No | No |

## Local Data

EasyMoney stores local app data in `data/easymoney.sqlite`.

The `data/` directory is ignored by Git. Do not commit personal financial exports, databases, or generated import files.

## Development

EasyMoney uses Bun as its single runtime and package runner. Use `bun`/`bunx` for development, checks, scripts, and server execution. Do not add Python helper scripts, npm/yarn/pnpm workflows, or standalone Node commands for project tasks; `node:` imports are used only as runtime APIs inside code executed by Bun.

Install dependencies:

```bash
bun install
```

Start the desktop app:

```bash
bun run dev
```

The default desktop workflow is intentionally one-shot so source edits do not repeatedly quit and reopen the app. Rerun `bun run dev` when a change set is ready to test. `bun run dev:watch` is available when an explicit full rebuild/relaunch loop is useful; it is not hot module replacement.

For browser-only development, start the Bun web server:

```bash
bun run dev:web
```

The browser-only server listens on:

```text
http://localhost:4177
```

Set `PORT` to use a different local port:

```bash
PORT=80 bun run dev:web
```

Optional AI categorization:

```bash
OPENAI_API_KEY=sk-... bun run dev
```

You can also create an untracked `.env.local` file:

```bash
OPENAI_API_KEY=sk-...
```

The Transactions page can save the key to `.env.local` from the local UI if the server starts without one. The app loads `.env.local` on startup and also updates the running local server when you save the key in the UI. It only applies suggestions after you confirm them. Set `OPENAI_CATEGORIZATION_MODEL` to override the default model.

## Checks

Run the normal acceptance gate before committing:

```bash
bun run typecheck
bun run test
bun run lint
bun run build
```

GitHub Actions runs the same gate on pushes to `main` and pull requests.

## Useful Commands

```bash
bun run data:freshness
bun run data:freshness --catch-up
bun run rebuild:ledger
bun run build
bun run start
```

`data:freshness` prints machine-readable JSON for account freshness. Use `--catch-up` to print only the programmatic download plan grouped by institution. Application clients use the typed `dataFreshness` tRPC procedures.

`rebuild:ledger` is mainly for tests, migrations, and repair operations. The app should not rebuild the ledger for ordinary categorization edits.
