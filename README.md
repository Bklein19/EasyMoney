# EasyMoney

EasyMoney is a local-first personal finance app for importing bank, credit card, and investment files into a source-fact ledger, then reviewing transactions, accounts, budgets, net worth, performance, savings rate, and analytics from materialized read models.

## Features

- Import CSV, PDF, TXT, and HTML exports from supported institutions.
- Preview imports with parser matching, account mapping, duplicate detection, and warnings before commit.
- Store raw import files and parsed source facts as the durable source of truth.
- Rebuild materialized transactions and balances deterministically from committed source facts.
- Categorize transactions separately from imported facts so notes and categories survive rebuilds.
- Review accounts, transactions, budgets, net worth, performance, savings rate, and spending analytics.
- Keep app data and connection credentials local on the machine.

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
| Sequoia Fund | PDF statements | Yes | Yes | Fixed fund account | No | No |
| TIAA | CSV activity, PDF statements | Yes | Yes | Fixed retirement account | No | No |
| Vanguard | PDF activity, PDF statements | Yes | Yes | Yes | No | Masked suffix when present |
| Wells Fargo | CSV activity, PDF statements | Yes | Yes for statements | Yes when filename/statement identifies it | No | Last four from filename or statement |
| Custom CSV mapping | CSV activity | Yes | No | User-selected or mapped | No | No |

## Local Data

EasyMoney stores local app data in `data/easymoney.sqlite`.

Plaid access tokens are stored separately in `data/plaid-items.json` with owner-only file permissions. They are never returned to the frontend or stored in imported source facts.

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

### Plaid proof of concept

The Connections page can connect Plaid in read-only mode and inspect accounts, transactions, investments, and available bank statements. Plaid data is not imported into the EasyMoney source-fact ledger yet.

Start in Sandbox:

```bash
PLAID_ENV="sandbox"
PLAID_CLIENT_ID="your-client-id"
PLAID_SANDBOX_SECRET="your-sandbox-secret"
PLAID_PRODUCTION_SECRET="your-production-secret"
```

Put these values in the untracked `.env` file and restart `bun run dev`. Change `PLAID_ENV` to `production` when you are ready to connect real accounts. Production institutions that use OAuth also require an HTTPS redirect registered in the Plaid Dashboard:

```bash
PLAID_REDIRECT_URI="https://your-registered-host/connections"
```

Bank/card connections initialize Transactions and request Statements when the institution supports them. Investment connections initialize Investments separately so institutions are not hidden merely because they do not support bank transaction or statement products.

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
