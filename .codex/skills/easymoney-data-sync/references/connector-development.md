# Connector Development And Readiness

Use this reference when implementing, repairing, or validating an EasyMoney
institution connector. The production connector and current persisted run
evidence are authoritative. The connector must live under
`server/app/dataSync/institutions/` and use shared `server/app/dataSync/`
infrastructure. Never create or revive a skill-local institution script: that
would be a second implementation with different behavior from the app.

## Production-Backed Development Runner

Use the generic runner around the current registered connector for live
iteration:

```bash
bun run connector:develop -- \
  --institution <registered-institution-id> \
  --source-plan /absolute/path/to/private-source-plan.json
```

The source plan must be generated from the current app planning context. It can
contain account identifiers and other private metadata, so keep it outside the
repository with owner-only permissions and never print or commit it. Do not
invent a fixed-account plan, copy a stale plan between institutions, or redact
fields the production connector needs. The runner creates a fresh output
directory, executes the same registry, planning, browser/session, download,
validation, and parser code used by the app, and persists only a PII-free
result.

Use `--profile <pii-free-label>` only when exercising a specific supported
connection profile. Optional `--overlap-days`, `--root`, `--run-id`, and
`--today` values are development controls, not institution behavior. The app's
Import-page **Catch up** action remains the final user-driven path.

## Evidence Ladder

These states measure functional readiness. They do not imply that browser
automation has been minimized; report transport maturity separately below.

Advance one state at a time. Never describe a connector using a later state
until the earlier evidence exists.

1. **Offline green**
   - The production connector is registered and uses the shared browser/session
     infrastructure.
   - Focused protocol, routing, parser, and failure tests pass.
   - Full tests, typecheck, lint, and the packaged build pass.
   - This does not prove login, discovery, download, or app behavior.

2. **Live harness green**
   - A connector-owning subagent runs a thin harness around the same production
     connector/session code. Do not create a second DOM implementation.
   - Use `bun run connector:develop` around the production connector. Extend
     that institution-agnostic runner when shared capability is missing; never
     add a per-institution executable to this skill.
   - The user completes credentials, MFA, and CAPTCHA in exactly one headed
     browser while the harness retains Playwright ownership.
   - The run dynamically identifies every intended remote account, performs
     authenticated requests, validates response status and file signatures,
     and passes the exact production parsers and routing checks.
   - Persist a PII-free result or run record with the exact safe failure stage.
   - Iterate here until this succeeds. Do not use the app button as the debugging
     harness.

3. **Button-ready**
   - Live harness success came from the same connector code now integrated on
     main, and the app was rebuilt once after the completed logical change.
   - No pending import review obscures the target control, no browser profile is
     leased, and no institution run is already active.
   - Prepare the app and hand the final action to the user. Do not click or invoke
     the backend path as a substitute for the user's app-button test.

4. **Proven end to end**
   - The user starts the run from the app button.
   - Authentication, discovery, downloads, parser validation, routing, and
     review staging complete on the button path.
   - The user resolves mappings and explicitly confirms the import.
   - The persisted run is complete and the expected source facts are recorded.
   - A staged review, discarded review, test result, or downloaded file alone is
     not end-to-end proof.

If a pending review hides the catch-up control, stop and ask the user to confirm
or discard it. Do not bypass that state with a direct backend invocation while
calling the result a button test.

## Live Iteration Contract

- Keep live connector iteration in its owning subagent. The coordinator reports
  status and preserves the distinction between harness and button testing.
- Confirm that the selected harness imports the current production connector
  rather than encoding a second account list, routing scheme, or browser flow.
  A stale harness is a blocker to fix, not a reason to advance to the app button.
- Before every launch, prove there is no active run, profile lease, or existing
  browser for that institution. Launch exactly one browser.
- Announce authentication readiness only after the shared Playwright/CDP
  diagnostic proves a headed native window is normal, on-screen, and foreground
  activation was requested. If delivery cannot be proven, fail immediately;
  never wait through a phantom login timeout.
- Computer Use's Chrome state is not evidence about a Playwright-launched
  Chrome. Inspect it with the owning Playwright session, a purpose-built
  Playwright script, or an attachable Playwright CLI session.
- Keep the browser/controller alive across login and the authenticated work.
  Do not close one process and assume session-cookie handoff to another process
  is lossless.
- The user owns credential, MFA, CAPTCHA, mapping, confirm, and discard actions.
  Never log or persist their values.

## Connector Shape

- Use browser UI for authentication and for discovering dynamic request metadata
  when necessary. Prefer authenticated HTTP requests for account discovery and
  artifacts once the server contract is known. Use DOM download controls only
  when no safe request contract exists or a genuine browser gesture is required.
- Discover accounts dynamically and map them by verified institution identity.
  Do not depend on a fixed account count, list position, display nickname, or
  account holder unless that field is authoritative for the institution.
- Validate destination origin, request method and fields, status, content type,
  file signature, parser match, parsed account identity, and coverage before an
  artifact is ready.
- Fail closed on missing or ambiguous identity, scope, document, or response
  metadata. Error messages and persisted diagnostics must remain PII-free.
- Use shared browser identity, automation-signal suppression, session
  persistence, HTTP transport, and window-delivery infrastructure without
  institution opt-ins unless the site's protocol genuinely requires a narrower
  behavior.

## HTTP Target And Transitional Implementations

The intended endpoint is authenticated HTTP for the whole data flow: account
discovery, account identity, date ranges, document lists, activity, and artifact
downloads. Use the browser for user login/MFA and session establishment where
required, and reuse authenticated state when the server accepts it.

Browser automation is useful for discovering a working flow and observing its
network protocol. Treat a connector that clicks controls to generate requests as
an intermediate implementation, even when its final download uses HTTP. Replace
those recurring clicks, date fills, dropdown selections, and download-event
capture with requests built from live server metadata. HTML returned by HTTP may
be parsed for tokens and forms; a rendered DOM is not inherently required.

Use the working browser implementation as an instrumented reference:

1. Observe requests, responses, redirects, and cookie/CSRF transitions around
   each meaningful UI action. Identify endpoints, methods, body schemas, account
   and document identifiers, pagination, date filters, and required ordering.
   Inspect sensitive values only within the private live session; persist safe
   protocol descriptions and synthetic fixtures, not raw bank traffic or tokens.
2. Trace where dynamic request values originate. Obtain them from authenticated
   responses in the HTTP implementation rather than hard-coding captured values
   or replaying a stale authenticated request.
3. Exercise equivalent requests through the shared transport in the same live
   session, then through the production connector on a fresh run. Compare
   discovered accounts, coverage, and parsed transaction/balance facts with the
   working browser path, including pagination and empty results.
4. Remove the corresponding recurring UI operations once equivalence is proven.
   Keep any remaining browser requirement narrow and evidence-backed. Capturing
   the same request by clicking the same control on every run is still a hybrid
   implementation; instrumentation should teach the connector the protocol.

Distinguish these implementation states when auditing or reporting progress:

- **Direct HTTP after authentication:** discovery and downloads use an HTTP
  client such as the shared Playwright request context, without rendered-page
  interactions. This can still retain Chrome for authentication/session support.
- **Browser-hosted HTTP:** explicit API requests run through browser `fetch` for
  verified session, origin, or transport requirements. This minimizes UI
  automation but is not browser-independent; identify any required navigation.
- **Hybrid or UI-driven:** recurring DOM reads, clicks, form manipulation, or
  request/download capture remain in the data flow. List them as migration work.

Prefer direct HTTP when equivalent behavior is verified. Use browser-hosted HTTP
when needed, and retain individual UI operations only with concrete evidence of
why the server contract cannot currently be exercised directly. Record the
remaining operation, reason, and next experiment in the institution reference.
Do not infer that HTTP is impossible from a single rejected request: first check
method, origin, cookies, CSRF state, headers, redirects, and request order.

When connector development or HTTP migration is in scope, continue from a working
UI prototype toward this target. A readiness audit alone does not authorize a
rewrite or new live bank runs. Preserve account routing, parser validation, and
the live-harness/app-button evidence gates during migration. Local-file ingestion
connectors should be reported separately from bank HTTP integrations.

## Iteration Loop

1. Read the newest persisted safe result before diagnosing; do not make the user
   repeatedly transcribe an error already recorded by the app.
2. Reproduce through the agent-owned live harness and inspect it with Playwright.
3. Fix the production connector or shared infrastructure, add a focused
   regression test, and rerun the relevant acceptance checks.
4. Repeat the harness with one browser until parser-validated artifacts succeed.
5. Commit and integrate the logical change, then rebuild/relaunch the desktop app
   once. Do not use desktop watch/reload churn as pseudo-HMR.
6. Declare button-ready and let the user perform the final button test.

Use the status terms **offline green**, **live harness green**,
**button-ready**, and **proven end to end** in progress reports. This prevents
tests, a browser launch, or a staged preview from being mistaken for stronger
evidence.
