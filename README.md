# EasyMoney

EasyMoney is a local-first personal finance app for importing bank, credit card, and investment files into a source-fact ledger, then reviewing transactions, accounts, budgets, net worth, performance, savings rate, and analytics from materialized read models.

## Features

- Import CSV, PDF, TXT, and HTML exports from supported institutions.
- Preview imports with parser matching, account mapping, duplicate detection, and warnings before commit.
- Store raw import files and parsed source facts as the durable source of truth.
- Rebuild materialized transactions and balances deterministically from committed source facts.
- Categorize transactions separately from imported facts so notes and categories survive rebuilds.
- Review accounts, transactions, budgets, net worth, performance, savings rate, and spending analytics.
- Keep all app data local in SQLite.

## Import Model

Imports are intentionally separate from categorization.

- Parsers parse files into source transactions, source balances, and source account context.
- Import preview lets you confirm account mappings and inspect duplicate or parser warnings.
- Import commit saves confirmed source facts and materializes app read models.
- Categorization happens later from the Transactions UI and is stored as user annotation data.
- Unimport marks an import inactive and rebuilds from the remaining active source facts.

This model is meant to handle overlapping activity exports without dropping real same-day duplicate purchases.

## Local Data

EasyMoney stores local app data in `data/easymoney.sqlite`.

The `data/` directory is ignored by Git. Do not commit personal financial exports, databases, or generated import files.

## Development

EasyMoney uses Bun as its single runtime and package runner. Use `bun`/`bunx` for development, checks, scripts, and server execution. Do not add Python helper scripts, npm/yarn/pnpm workflows, or standalone Node commands for project tasks; `node:` imports are used only as runtime APIs inside code executed by Bun.

Install dependencies:

```bash
bun install
```

Start the Bun server:

```bash
bun run dev
```

The app is served by the Bun backend. By default it runs on:

```text
http://localhost:4177
```

Set `PORT` to use a different local port:

```bash
PORT=80 bun run dev
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

`data:freshness` prints machine-readable JSON for account freshness. Use `--catch-up` to print only the programmatic download plan grouped by institution.

The same JSON is available from the local app server:

```text
GET /api/app/data-freshness
GET /api/app/data-freshness/catch-up
```

`rebuild:ledger` is mainly for tests, migrations, and repair operations. The app should not rebuild the ledger for ordinary categorization edits.
