# Connector Development And Readiness

Use this reference when implementing, repairing, or validating an EasyMoney
institution connector. The production connector and current persisted run
evidence are authoritative. Institution scripts and these notes are harnesses
and guidance; update them when they drift instead of rebuilding an obsolete
parallel connector.

## Evidence Ladder

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
   - If no current harness exists, add a committed, institution-agnostic
     development runner around the production connector primitives. Temporary
     output directories are appropriate; deleted `/private/tmp` runner code and
     legacy fixed-account scripts are not durable parity evidence.
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
