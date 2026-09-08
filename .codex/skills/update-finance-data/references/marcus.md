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
