# Bank of America

Bank of America is a registered EasyMoney connector. Its production entrypoint
is `server/app/dataSync/institutions/bankOfAmericaConnector.ts`, backed by
`bankOfAmerica.ts` and shared data-sync browser/session infrastructure. There is
no skill-local downloader.

## Run And Iterate

Use the Bank of America **Catch up** action on the Import page for the product
path. For authenticated connector iteration, use the generic runner with a
private plan generated from the current app context:

```bash
bun run connector:develop -- \
  --institution bank-of-america \
  --source-plan /absolute/path/to/private-source-plan.json
```

The user completes credentials, MFA, and CAPTCHA in the single headed browser
owned by that run. Do not replace the production connector with a standalone
script or a fixed account list.

## Current Connector Contract

- Plans active Bank of America checking, savings, deposit, and credit-card
  accounts from ledger coverage.
- Requires an unambiguous account kind and last four for automatic routing.
- Discovers live account controls and request metadata during the authenticated
  run instead of persisting account tokens.
- Downloads overlapping activity where supported and statements for balance
  anchors.
- Validates CSV/PDF shape and the matching EasyMoney parser before returning an
  artifact.
- Routes each artifact back to the planned local account by kind and last four.

Historically observed website labels such as **Download Account Activity** and
statement/document controls are useful clues, not a durable API. Re-verify the
current site through the owning Playwright session whenever those controls
change.
