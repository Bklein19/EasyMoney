# Robinhood Credit Card online connector investigation

Status on 2026-11-03: **online connector implemented; live harness green**.
`robinhood-credit` downloads credit-card activity and the current balance using
authenticated HTTP after first-party browser login. `robinhood-banking` continues
to ingest local banking exports; manual credit-card CSV/PDF imports remain
supported. The final user-started app-button run and import confirmation have not
yet been performed.

## Verified in the production-backed development runner

- The current first-party web app recognizes banking destinations at
  `https://robinhood.com/login/?to=%2Fbanking` and selects its card-specific login
  presentation. The user completed credentials and MFA on Robinhood's site.
- Successful login redirected to `/us/en/banking/`, a marketing page, not an
  authenticated card dashboard. The browser's saved authentication was retained
  using the shared private profile infrastructure.
- The first-party `web:auth_state` storage supplies a bearer token with `internal`
  scope. Tokens were used only in memory; no credentials or tokens are recorded
  here, in source code, or in diagnostic output.
- A read-only POST to `https://api.robinhood.com/creditcard/graphql` with that
  token successfully returned `authIdentity.creditCustomers { id account { id } }`.
  The returned types were `CreditCustomer` and `CreditAccount`.
- Account capabilities included account-scoped transaction, document, and balance
  access. This establishes account discovery, **not** a working export request.
- `transactionSearch(q: TransactionSearchRequest!)` accepted the historical input
  shape (`creditCustomerId`, `filters.values`, `sortDetails`, `limit`) but returned
  HTTP 200 with a GraphQL resolver error at `transactionSearch`. Required-input
  validation also showed that filters and sort details remain required.
- The same resolver error occurred with the original `TransactionListQuery`
  operation name and with a minimal selection. Schema introspection did not
  produce a usable schema. A GraphQL HTTP 200 must not be treated as success.
- Supplying the historically observed `x-x1-client` header using the current
  official Robinhood Banking app version caused browser CORS failure. An
  equivalent direct HTTP request in the same authenticated session, with redirects
  disabled, still returned the resolver error both with and without the header.
  Thus CORS and this client header alone do not explain the export failure.
- Customer identifiers are opaque. No identifier decoding or fabricated IDs were
  used to bypass the unresolved request contract.
- Retained authentication was exercised headlessly. This initial protocol probe
  did not download artifacts or modify the ledger. The successful native-query
  implementation and its stronger evidence are recorded below.

## Verified native-package analysis

The user authorized static analysis instead of setting up phone traffic capture.
The Android package was retrieved directly from Google Play using anonymous
download access; neither a Robinhood login nor the user's Google account was
needed. The app was never installed or executed.

- Package: `com.robinhood.money` (the separate Banking app, not brokerage).
- Version: `2.28.2`, Android version code `547`.
- Base APK SHA-256:
  `0828e046c813802932fe99952b18a336a2a1f56a34870aa1d70d1083e0fee0ab`.
- Signing certificate SHA-256:
  `82:59:FA:51:3C:FD:54:A6:AA:8D:93:43:50:1B:FA:13:45:8C:55:D2:5E:27:C5:8F:8D:CA:03:EF:E2:F0:02:E5`.
  This matches Robinhood's public Digital Asset Links entry for this package.
  APK v2 signatures, public-key consistency, and signed content digests were
  checked for the base APK and all three delivered configuration splits.
- The app includes `assets/index.android.bundle`, Hermes bytecode version `98`.
  Its string table and bytecode were inspected with a matching official Hermes
  compiler. APKs and extracted app code remain outside the repository.

The bundle confirms the production API base `https://api.robinhood.com/creditcard`
and the following protocol details:

- `CriticalDataProviderQuery` obtains `authIdentity`, its credit customers,
  capabilities, accounts, and primary-card references.
- `TransactionListQuery` still calls
  `transactionSearch(q: TransactionSearchRequest!)`. Its current selection
  includes transaction identity, micro-unit amount, flow, status, type, timestamp,
  visibility, merchant details, and a pagination cursor. The old query name and
  endpoint were therefore not merely historical guesses.
- A newer `UnifiedTransactionListQuery` calls
  `unifiedTransactionSearch(q: UnifiedTransactionSearchRequest!)`, returning
  `transactions { items { ... } cursor }` with credit/bank transaction details.
  Its request builder supplies `userInformation { creditCustomerId, identityId }`,
  `filters { values, transactionTypes, bankAccountIds, identityIds, presetFields,
transferAccountIds, transferScheduleIds }`, `sortDetails { field: "TIME",
ascending: false }`, `limit: 40`, and `cursor`. The component defaults to both
  `CREDIT` and `BANK` transaction types. A credit-card connector should request
  only `CREDIT` and validate the returned detail type and account identity.
  This is a separate candidate for live read-only validation.
- The native app explicitly exports `AuthScope = "credit-card"`; the saved
  first-party browser session has `internal` scope. This is a verified
  difference, not proof that scope alone caused the observed resolver failure.
- The native app supports an OAuth PKCE handoff via `robinhood://oauth`, with a
  Banking-app callback. Its `/auth/code` POST has JSON fields `clientId`,
  `redirectUri`, `code`, `deviceToken`, `deviceLabel`, and `codeVerifier`.
  Recovering this definition does not prove that an ordinary browser can
  complete the same handoff. Do not introduce password collection to work around
  the authentication gap.

Static inspection does not establish whether certificate pinning is enforced on
the current app's actual network path. No pinning bypass, device certificate
installation, proxy change, or phone capture was needed for these findings.

## Remaining evidence needed

The production-backed harness subsequently completed with the registered
connector, shared authenticated HTTP transport, and registered import parser:

- The current unified query succeeded with the existing `internal` browser token.
  A scope change or another login was unnecessary for this verified read path.
- Current balances are available through
  `authIdentity.creditCustomers.account.balances`; the separate root
  `creditAccount(q: ...)` resolver still failed. The connector uses the verified
  nested relationship, without decoding or inventing identifiers.
- A full-history bootstrap retained two exact transaction response bodies: one
  with 39 items and a final empty page. The terminal empty page repeated its
  requested cursor. The connector recognizes that end marker, continues through
  short pages or empty pages with a new cursor, and rejects populated cursor
  cycles instead of silently truncating history.
- One original-response JSON artifact passed the real import parser with
  **32 posted, visible transactions and one current liability balance**. Pending,
  reversed, and hidden rows stay in the retained original but are not imported.
  Dates use the retained browser time zone; amounts are validated micro-units.
- The artifact is owner-readable only and retains exact discovery, account,
  statement-catalog, and transaction response strings without session tokens.
  The harness did not import it, create accounts, or change annotations.
- All institution browsers closed and the private profile lease was released.

The verified account has no statement PDFs. Historical PDF downloading is not
implemented or claimed. The connector warns when a nonempty statement catalog
is found. It currently fails closed unless discovery returns one unambiguous card
account: linked transaction customer IDs differ from discovery IDs, so safe
multi-account attribution still needs a real multi-account validation session.

The remaining readiness gate is a user-started run from Import, followed by the
user's explicit account mapping and import confirmation. A successful harness
does not substitute for that app-button test.

Continue from the verified native definitions before asking for traffic capture.
If capture becomes necessary, setting up HTTPS inspection changes device trust
and requires explicit approval of the exact setup before installing a
certificate, changing proxy settings, or capturing traffic. Do not request
credentials or session tokens in chat. A supported provider integration is
another possibility, but adding a provider account, billing, or a new third-party
data recipient is a separate user decision.

After the request contract is verified, retain exact original response bytes or
bank-issued statements, validate account identity and pagination, and use the
existing source-fact import review. Test signs, settled/pending status, date
semantics, overlapping exports, duplicate occurrences, retained originals, and
annotation survival. Pass the live harness before exposing a final app-button test.

## Development support retained

`EASYMONEY_DEVELOPMENT_HEADLESS=1` together with the existing
`EASYMONEY_DEVELOPMENT_INSPECTOR` enables headless inspection through the shared
connector runner. Explicit headless mode never falls back to a visible login
window; expired authentication pauses the run. Normal app authentication behavior
is unchanged.

## References

- [Robinhood Gold Card integration FAQ](https://robinhood.com/us/en/support/articles/robinhood-gold-card-get-started/)
- [Original firsthand card API investigation (2024)](https://www.markjberger.com/inspecting-ios-https-traffic/)
- [Original exporter source](https://github.com/markberger/rh-cc-exporter)
- [Official Banking Android listing](https://play.google.com/store/apps/details?id=com.robinhood.money)
- [Robinhood's published Android signing fingerprints](https://robinhood.com/.well-known/assetlinks.json)
- [Android APK v2 signing format and verification](https://source.android.com/docs/security/features/apksigning/v2)
- [Official Hermes compiler package](https://www.npmjs.com/package/hermes-compiler)

The historical exporter is research context, not proof of the current API contract.
Robinhood's agentic-card MCP covers dedicated virtual cards, not the user's full
Gold Card history, so it is not a substitute for this connector.
