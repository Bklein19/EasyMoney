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

## Current Evidence And Remaining Work

- September 10, 2026: the current-app-plan development run reached expired
  authentication recovery, but headed startup failed before login delivery.
  The code-only stack identified the shared native-window screen-bounds
  evaluation racing TIAA's login redirect. A bounded shared retry now handles
  execution-context replacement, and the next production-backed run proved
  normal on-screen native window delivery and reached user login/MFA.
- The next authenticated run exposed a different bug: an opaque statement
  redirect was classified as expired authentication, causing repeated whole-flow
  recovery while the activity session remained signed in. Statement downloads
  now use shared direct HTTP with validated same-origin redirects. Opaque browser
  redirects alone are no longer treated as proof of expired authentication.
- The production-backed harness completed with one activity CSV and two statement
  PDFs, all parser-validated, using saved authentication without another login.
  Final app-button testing has not happened on this revision.
- Transport remains hybrid: activity-period selection and request capture use
  rendered controls; activity requests run in the browser, statements use direct HTTP.
  Instrument the working authenticated flow, derive dynamic period/request
  fields from server metadata, and compare direct HTTP before removing those
  UI steps. Do not treat the current browser transport as a demonstrated bank
  requirement.
