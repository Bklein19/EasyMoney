# Robinhood Credit Card online connector investigation

Status on 2026-11-03: **not implemented or ready for use**. The existing Robinhood
connector still ingests local mobile exports. An authentication-only prototype
and an unverified API parser were removed; neither was shipped as online support.

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
- Retained authentication was exercised headlessly. No transactions or statements
  were downloaded, no artifacts passed parser validation, and nothing was
  imported into the user's ledger. All investigation browsers and leases closed.

## Remaining evidence needed

The current native app's transaction/document request and authentication contract
is still unknown. It could differ from the historical query or require a
different token scope; the observed errors do not distinguish these explanations.
Do not label this an entitlement failure or claim direct HTTP is impossible.

A current, user-authorized native-app traffic capture would resolve the protocol
gap. Setting up HTTPS inspection changes device trust and requires explicit user
approval before installing a certificate, changing proxy settings, or capturing
traffic. Do not request credentials or session tokens in chat. A supported provider
integration is another possibility, but adding a provider account, billing, or a
new third-party data recipient is a separate user decision.

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

The historical exporter is research context, not proof of the current API contract.
Robinhood's agentic-card MCP covers dedicated virtual cards, not the user's full
Gold Card history, so it is not a substitute for this connector.
