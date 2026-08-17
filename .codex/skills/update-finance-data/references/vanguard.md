# Vanguard Catch-Up

Vanguard catch-up is a first-class EasyMoney data sync. The application owns
planning, browser automation, artifact validation, import, and ledger rebuild.
Do not recreate a standalone downloader in this skill.

## Run

Use **Catch up Vanguard** on the Import page, or invoke the same backend path:

```bash
bun scripts/sync.ts --institution vanguard --goal current --overlap-days 7
```

For the oldest available history:

```bash
bun scripts/sync.ts --institution vanguard --goal backfill
```

## Login Profiles

EasyMoney recovers PII-free login labels from committed artifact provenance.
Each login has its own persistent Chrome profile, and known Vanguard logins run
in parallel. Supported labels are `current`, `account-N`, and `login-N`; holder
names and account numbers must never be used as browser profile names.

When authentication expires, complete login and MFA in each open Chrome window.
EasyMoney waits on the existing page and continues without refreshing while
credentials are entered.

## Planning And Mapping

- Activity starts with a seven-day overlap before each account's latest fact.
- Backfill ends with overlap after each account's earliest fact.
- Missing completed monthly statements are planned from balance-fact coverage.
- Vanguard account controls and statement rows are matched by the account's
  last four digits, not by row position.
- Downloaded artifacts retain a PII-free login label in their filenames.
- Each artifact is committed to the account associated with that login and
  last-four identity, then the ledger is rebuilt once for the batch.
- Active Vanguard accounts without a known login profile or usable last four
  are skipped with a warning rather than guessed.

## Runtime Behavior

The Bun process owns headed Chrome contexts directly through Playwright. There
is no Playwright CLI daemon or socket. Browser authentication remains in local
EasyMoney profiles; credentials, cookies, tokens, and storage state are never
written to the repository.

The connector validates CSV structure and PDF magic/parser output before an
artifact reaches the import pipeline. Existing committed content hashes are
skipped, overlapping activity is deduplicated by the ledger rebuild, and the
shared browser executor shows the final `Done` screencast chapter.
