# Vanguard

Vanguard is a registered first-class EasyMoney connector. The authoritative
implementation is `server/app/dataSync/institutions/vanguardConnector.ts` plus
`vanguard.ts`; the application owns planning, browser automation, artifact
validation, routing, review staging, and import.

## Run And Iterate

Use the desired Vanguard connection's **Catch up** action on the Import page.
For a production-backed live development run:

```bash
bun run connector:develop -- \
  --institution vanguard \
  --source-plan /absolute/path/to/private-source-plan.json
```

The private source plan carries the current app's connection selection. Keep it
outside the repository and do not replace it with holder names, account numbers,
or a hand-written fixed profile. The user completes login and MFA in each
connector-owned headed window.

## Current Connector Contract

- Recovers PII-free login profile labels from committed artifact provenance.
- Plans overlapping activity and missing completed statements from ledger
  coverage for the accounts associated with each profile.
- Matches site accounts and statement rows by verified identity, including last
  four where required, rather than row position.
- Downloads activity and statements through authenticated requests or browser
  gestures as required by the current site contract.
- Validates file signatures, exact production parser output, account identity,
  and coverage before returning artifacts.
- Skips accounts without an unambiguous supported profile/identity and reports
  the reason rather than guessing.

Do not invoke `scripts/sync.ts` with command-line flags; that file is the app's
stdin worker protocol entrypoint. `connector:develop` is the supported live
iteration harness, and the app button is the required final path.
