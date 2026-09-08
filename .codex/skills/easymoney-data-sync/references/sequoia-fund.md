# Sequoia Fund

Sequoia Fund is a registered EasyMoney connector. The authoritative code is
`server/app/dataSync/institutions/sequoiaFundConnector.ts`, `sequoiaFund.ts`,
and `sequoiaFundProtocol.ts`. Do not maintain a fixed-window skill script.

## Run And Iterate

Use the selected Sequoia Fund connection's **Catch up** action on the Import
page. For live connector iteration:

```bash
bun run connector:develop -- \
  --institution sequoia-fund \
  --source-plan /absolute/path/to/private-source-plan.json
```

When the private plan contains multiple local Sequoia connections, preserve
the app-selected `connectionId`; do not infer one from list order. The user
completes fresh authentication in the one headed browser for the run.

## Current Connector Contract

- Each run selects exactly one local Sequoia account/connection.
- Requires exactly one login-level portfolio group from the authenticated
  portfolio response.
- Uses authenticated HTTP requests for portfolio discovery, aggregate activity,
  statement metadata, and artifact downloads; rendered filters are not treated
  as accounts.
- Downloads an overlapping aggregate activity export plus missing quarterly
  statements when available.
- Gives each artifact a PII-free canonical scope identity and routes all results
  to the selected local account.
- Validates request scope, status, content type, file signature, parser output,
  and account identity before staging review.

Never restore the historical fixed dates, fixed output directory, or DOM
selection flow. Current server responses and the production protocol parser are
the source of truth.
