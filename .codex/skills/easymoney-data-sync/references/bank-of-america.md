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

Transport maturity: **direct HTTP after authentication**. Account discovery,
credit-card export metadata, activity, statement indexes, and PDFs use the shared
authenticated HTTP request context. The data flow makes no page navigations,
rendered DOM reads, control selections, clicks, or download-event captures.

- Fetch the authenticated overview URL and parse its server-rendered account
  links with Bun's HTML parser. Resolve relative links and decode HTML entities
  before validating the Bank of America origin, redirect path, account token,
  kind, and last four. Deduplicate responsive-layout links by opaque token.
- Fetch each credit-card account destination over HTTP, following validated
  same-origin redirects. Parse `select_transaction` and `select_filetype` options
  from response HTML to obtain current account-specific period and format values.
  These are server metadata, not values captured by manipulating browser controls.
- Send deposit exports as multipart POSTs, statement indexes as JSON POSTs, and
  card CSV/PDF requests as GETs. The shared HTTP context retains session cookies
  and handles redirect/cookie transitions while the owning Chrome stays alive.
- Browser interaction remains only for user login/MFA and authentication-state
  checks. Browser-hosted HTTP is unnecessary for the verified endpoints.

- Plans active Bank of America checking, savings, deposit, and credit-card
  accounts from ledger coverage.
- Requires an unambiguous account kind and last four for automatic routing.
- Discovers live account identities and request metadata during the authenticated
  run instead of persisting account tokens.
- Downloads overlapping activity where supported and statements for balance
  anchors.
- Validates CSV/PDF shape and the matching EasyMoney parser before returning an
  artifact.
- Routes each artifact back to the planned local account by kind and last four.

The September 2026 HTTP migration was exercised against the live production
connector. Direct and browser-hosted overview requests both returned HTTP 200
and the same account-link count and response size. The direct data flow downloaded
four CSVs and three PDFs covering all three planned accounts; every artifact
passed the exact production parser and account-identity checks. Keep live harness
evidence distinct from the user's final app-button import confirmation.

Historically observed website labels such as **Download Account Activity** and
statement/document controls are useful clues, not a durable API. Re-verify the
current site through the owning Playwright session whenever those controls
change.
