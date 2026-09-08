# Wells Fargo

Wells Fargo is a registered EasyMoney connector. The authoritative code is
`server/app/dataSync/institutions/wellsFargoConnector.ts` plus
`wellsFargo.ts`. Do not use or recreate the former fixed three-account skill
script.

## Run And Iterate

Use the Wells Fargo **Catch up** action on the Import page only after the live
harness is green. For authenticated connector development:

```bash
bun run connector:develop -- \
  --institution wells-fargo \
  --source-plan /absolute/path/to/private-source-plan.json
```

The user completes login and MFA in exactly one headed browser owned by that
run. The source plan comes from current app account coverage and must remain
private; never substitute a hard-coded checking/card list.

## Current Connector Contract

- Plans all active Wells Fargo checking, savings, and credit-card accounts that
  have an unambiguous account kind and last four.
- Uses separate ledger-derived windows for activity and statement/balance
  coverage.
- Discovers live accounts by verified kind and last four, not product nickname
  or list position.
- Downloads posted activity CSVs and available statement PDFs through the
  current authenticated site contract.
- Requires the expected CSV structure or PDF signature plus successful
  production parser validation before returning an artifact.
- Routes every result to its planned local account and rejects unexpected or
  ambiguous identities.

Historically observed labels such as **Download Account Activity** and **View
Statements** may help locate a changed flow, but they are not an alternative
implementation. Inspect failures through the owning Playwright process and fix
the in-codebase connector before any app-button test.
