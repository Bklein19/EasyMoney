# Fidelity

Fidelity is a registered EasyMoney connector. The authoritative implementation
is `server/app/dataSync/institutions/fidelityConnector.ts` plus `fidelity.ts`.
Do not recreate its browser, request, parser, or routing logic in this skill.

## Run And Iterate

Use the Fidelity **Catch up** action on the Import page for the product path.
For authenticated iteration against exactly the same connector code:

```bash
bun run connector:develop -- \
  --institution fidelity \
  --source-plan /absolute/path/to/private-source-plan.json
```

The user completes login and MFA in the single headed browser retained by the
runner. A source plan can contain private account context; keep it outside the
repository, owner-readable only, and never print or commit it.

## Current Connector Contract

Transport maturity: **direct HTTP after authentication**. The production flow
uses `fidelityHttp.ts` request contracts and the shared authenticated HTTP client
for account discovery, activity, statement lists, and PDF downloads. Chrome opens
the authenticated activity entrypoint for session establishment/login; no
account/date/year controls, document navigation, browser fetch, or download clicks
remain in the data flow.

- Combines the ledger-derived coverage windows for active Fidelity accounts.
- Discovers brokerage and workplace/retirement accounts from the account API.
  Stock-plan holdings link to their parent brokerage and are not treated as
  independent activity accounts. Unsupported account categories fail explicitly.
- Builds exact activity account/date scope from live account metadata, with
  Eastern-time day boundaries including DST transitions.
- Requests each covered statement year directly, resolves document account type
  against account API metadata, and downloads only intersecting PDFs.
- Supports parser-validated activity JSON/CSV and statement PDF/HTML artifacts
  when the corresponding Fidelity surface provides them.
- Requires parser-backed remote account claims and leaves ambiguous account
  mapping for explicit review rather than guessing.
- Rejects login pages, redirects, bad status/content types, malformed artifacts,
  and statement/account identity mismatches before staging review.

The account API lives on `dpservice.fidelity.com`, activity on
`digital.fidelity.com`, and statement APIs on `digitalservices.fidelity.com`.
Requests are restricted to the exact verified endpoints; redirects remain inside
the shared transport's origin boundary. Document APIs require the public
`fid-originating-app-id` and `fid-originating-app-version` protocol headers.
Do not reintroduce rendered-page navigation merely to switch API origins.

## HTTP Migration Evidence

On September 8, 2026, the instrumented production UI baseline and replacement
HTTP flow returned identical activity payloads for both discovered accounts and
identical parsed statement facts. The subsequent fresh production development
run restored authentication without user login and persisted three artifacts
with three parser validations (two activity JSON files and one statement PDF).
This is live harness evidence for the HTTP migration; the updated connector
still needs the user's final app-button test before renewed end-to-end claims.

If the API changes, inspect the working browser flow's network protocol privately
and update the request contracts. Do not recreate the retired DOM connector.
