# Marcus

Marcus is a registered EasyMoney connector. Its production implementation is
`server/app/dataSync/institutions/marcusConnector.ts` plus `marcus.ts`; the
skill does not carry a second statement downloader.

## Run And Iterate

Use the Marcus **Catch up** action on the Import page for the product path. For
authenticated development:

```bash
bun run connector:develop -- \
  --institution marcus \
  --source-plan /absolute/path/to/private-source-plan.json
```

The user completes login and MFA in the one browser owned by the production-
backed runner. Diagnose from its persisted safe result before asking the user
to transcribe an app error.

## Current Connector Contract

- Plans active Marcus or Goldman Sachs Bank USA accounts from ledger coverage.
- Currently supports the online-savings statement format; unsupported deposit
  account kinds fail closed.
- Requires an unambiguous supported account kind and last four for automatic
  routing.
- Discovers statement metadata and performs authenticated document requests
  through shared browser/request infrastructure.
- Requires PDF magic, parser-valid coverage, exactly one balance claim, and a
  matching statement account identity before returning an artifact.
- Routes every artifact to the planned local account and rejects unplanned or
  duplicate results.

Document endpoints and transport requirements have changed in the past. Treat
status codes, content types, and parser validation as separate stages and fix
the in-codebase connector at the first failing stage.

## Verified Transport And Readiness

The 2026-09-10 local live harness succeeded after user login and on three fresh
saved-session runs: each produced five parser-validated statements. The earlier
statement 403 did not recur after fresh authentication. This is live-harness
evidence, not a final app-button/confirmed-import result.

- Statement downloads currently use first-party proxy requests through Chromium
  networking with the bounded HttpOnly cookie policy. Same-session full-cookie
  browser fetch also returned a valid PDF.
- Direct HTTP requests returned 403 for both catalog POSTs and the statement.
  The statement still returned 403 with the working browser request's exact
  ordinary headers and cookies. This supports retaining browser-hosted transport
  for now; it does not establish that every possible HTTP client is incompatible.
- Chrome's captured headers include HTTP/2 pseudo-headers. Strip these before
  replay; otherwise the HTTP client rejects the request locally, which is not
  evidence of a Marcus server rejection.
- Account/document metadata still comes from captured API responses triggered
  by the authenticated accounts/documents routes. This remains hybrid, not a
  finished HTTP migration. The next migration step is to derive the catalog
  operation contract and token sources from that traffic, then exercise explicit
  browser-hosted catalog requests without recurring route-based capture.

Always associate private diagnostic output with the active run/process and its
timestamp. A prior probe file is not evidence of the current run's auth or error.
