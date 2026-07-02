# EasyMoney Agent Notes

## Repository Workflow

- Stay on `main` unless the user asks for a branch.
- Use simple kebab-case branch names when a branch is needed.
- Commit early and often: commit each logical set of changes after running the relevant checks.
- Collaboration is direct-to-main: multiple people may push to `main`. If `git push origin main` is rejected because remote has new work, run `git pull --rebase origin main`, resolve any conflicts without dropping other people's changes, rerun the relevant checks, then push again.
- Prefer Bun commands for this repo:
  - `bun run typecheck`
  - `bun test`
  - `bun run lint`
  - `bun run build`
- Use Bun as the single runtime and package runner for repo work. Do not add Python helper scripts, npm/yarn/pnpm workflows, or standalone Node commands for project tasks. `node:` imports are fine inside TypeScript/JavaScript that runs under Bun.

## Architecture Direction

EasyMoney is moving from legacy table CRUD toward a source-fact ledger model.

- Do not write new application code in JavaScript. New code should be TypeScript.
- When working in an existing JavaScript file, convert the touched code to TypeScript when practical instead of expanding the JavaScript surface area.
- The old `money/` reference app was removed from the working tree. Use git history if you need to inspect it.
- Raw imports and parsed facts are the durable source of truth.
- Ledger/materialized tables are read models rebuilt from committed source facts.
- New product behavior should go through the typed application layer, not direct table-shaped CRUD.
- Do not add fallbacks to legacy transaction/account tables for new ledger-backed behavior. Make the new path work.
- Frontend logic should not own critical financial semantics. Put import, ledger, balance, transaction identity, duplicate handling, and analytics semantics in the backend/application layer.

## Import Invariants

- Parsers parse. They should not categorize transactions.
- Import preview may show suggestions, warnings, duplicates, parser matches, and account mappings.
- Commit saves confirmed import facts and user choices. Categorization is a separate workflow.
- Imported files should produce source records such as source files, source accounts, source transactions, and source balances before materialized app rows.
- Overlapping activity exports must dedupe generically by source identity and occurrence count. Do not treat same-day same-amount same-description transactions as automatic duplicates across the whole ledger; two real identical purchases on the same day must survive.
- Consolidated statements are expected. Parser outputs should preserve institution/account context when available.

## Rebuild Invariants

- The ledger rebuild should be deterministic and order independent for committed source facts.
- Materialized transaction IDs must be stable enough that user data such as categorization and notes can survive rebuilds.
- Transaction categorization and notes belong in user annotation tables keyed by stable ledger transaction identity, not in raw import rows.
- Rebuilding should replace materialized read models from source facts. It should not delete user annotations.
- The rebuild script is mainly for tests, migrations, and repair operations. The app should not need to rebuild on every categorization edit.

## Unimport Invariants

Unimport means: mark the import/source file inactive, then rebuild from the remaining committed facts.

- Do not hard-delete source facts as the primary unimport behavior.
- Do not delete transaction annotations during unimport.
- Do not unlink source accounts from app accounts during unimport.
- Do not manually mutate materialized transactions, balances, or legacy account balances to simulate unimport. Rebuild them from the active committed source facts.
- `sourceFiles.status` and `importFiles.status` should reflect whether a file participates in rebuilds.

## Account And Transaction Invariants

- Manual transaction entry should not be reintroduced.
- Transaction deletion should not be exposed as ordinary product behavior. Correct source data by unimporting/reimporting or by future source-level repair tools.
- Account current balance should not be manually updated. Balances should come from imported/source balances or ledger-derived read models.
- Account metadata edits are acceptable: name, institution, type, currency.
- Account hard delete is not acceptable while source facts, annotations, and migration safety depend on stable account identity. Add archive semantics later if needed.
- Category CRUD is acceptable for now. Categories are user-facing metadata; they are not raw import facts.

## Testing Expectations

- Add focused tests when changing import, rebuild, dedupe, annotation, balance, or materialization behavior.
- Tests should cover invariants, not just endpoint status codes.
- For import changes, include overlapping-file and duplicate-occurrence cases when relevant.
- For unimport/rebuild changes, assert user annotations and source-account mappings survive.
