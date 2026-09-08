# TIAA

TIAA is a registered EasyMoney connector. The current implementation lives in
`server/app/dataSync/institutions/tiaaConnector.ts` and `tiaa.ts` and uses the
shared browser/session layer. There is no separate skill downloader.

## Run And Iterate

Use the TIAA **Catch up** action on the Import page for the product path. For an
authenticated production-backed development run:

```bash
bun run connector:develop -- \
  --institution tiaa \
  --source-plan /absolute/path/to/private-source-plan.json
```

The user completes login and MFA in the one headed browser retained by the
runner. Keep the private source plan and browser profile outside the repository
and never log account selectors or tokens.

## Current Connector Contract

- Combines transaction and balance coverage windows across active TIAA
  accounts.
- Discovers offered accounts, activity periods, and statement documents at
  runtime rather than using a fixed year or statement list.
- Retrieves activity CSVs and quarterly statement PDFs when available.
- Requires the native TIAA activity shape and parser-valid statement balances.
- Uses parser-backed claim keys to route multi-account artifacts; missing or
  duplicated claims fail closed for review safety.
- Reports unavailable or empty activity periods separately from successful
  statement downloads.

Historically observed Quick Download and Statements labels are mutable. When
the site changes, inspect the current connector-owned Playwright session and
update production selectors/request handling, not this reference with an
alternate implementation.
