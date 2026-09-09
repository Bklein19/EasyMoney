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

Transport maturity: **hybrid**. The data path still selects accounts and fills
date filters to capture activity requests. Statements navigate Documents, select
years, and click download controls to capture requests before replaying them
through browser-hosted HTTP. These are transitional discovery mechanisms, not
proof that Fidelity requires UI automation. Next, obtain account/request metadata
from authenticated responses and build activity/list/download requests directly,
preserving the existing exact identity and scope validation.

- Combines the ledger-derived coverage windows for active Fidelity accounts.
- Discovers retail and workplace/retirement accounts dynamically.
- Uses authenticated activity and statement requests after capturing and
  validating the live request contract.
- Supports parser-validated activity JSON/CSV and statement PDF/HTML artifacts
  when the corresponding Fidelity surface provides them.
- Requires parser-backed remote account claims and leaves ambiguous account
  mapping for explicit review rather than guessing.
- Rejects login pages, redirects, bad status/content types, malformed artifacts,
  and statement/account identity mismatches before staging review.

The site's Portfolio, Activity, Documents, and workplace surfaces are mutable.
Inspect current requests and pages through the connector-owned Playwright
session rather than reviving old DOM steps or fixed account-class selectors.
