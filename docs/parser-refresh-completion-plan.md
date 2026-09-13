# Parser refresh completion plan

## Success criteria

Automatically reparse retained originals, reconcile overlaps, preserve confirmed
account choices and user annotations, apply validated changes atomically, and
verify that a second run makes no changes. Tests and a private replay alone are
not live completion.

## Work sequence

1. Enforce original retention for every path, including Playwright and HTTP
   connector downloads. Persist bytes and checksum before commit; restartable
   staged review must not depend on temporary download directories. Verify
   originals or explicitly approved replacements for every active source file.
   Keep committed originals through unimport/reparse/rebuild and verify backup
   restoration. Exercise production app-button staging, not just manual upload.
2. Produce revision-bound refresh diagnostics covering file validation, account
   mappings, ledger changes, and annotation dispositions. Reject stale previews.
3. Preserve annotations through source-occurrence lineage. Transfer only through
   unambiguous evidence; review conflicting categories or non-empty notes. Keep
   annotations on intentionally excluded non-transactions in accessible history,
   without copying them onto real purchases. Never match annotation ownership by
   amount or ordinal alone.
4. Resolve the known account-identity and date/amount validation failures using
   retained originals and confirmed choices. Preserve owner/consolidated-account
   boundaries; persist evidence-backed identity aliases. Ask for genuinely
   uncertain choices rather than guessing or dropping facts.
5. Verify the eight Vanguard matches and preservation of four airline charges.
   Record source-bound distinctness evidence for the airline false positive;
   do not weaken general nearby-date safeguards.
6. Replay all active originals privately, explain ledger deltas, run regression
   tests/typecheck/lint/build, and commit tested logical changes on main.
7. Take a verified recoverable backup, apply to live only after validation, inspect
   the actual app ledger and annotations, then verify a no-op second run/restart
   and a repeat-import “nothing new” result.

## Approved defaults

- Apply and verify the live refresh once safe; do not stop at an offline preview.
- Conflicting annotation values require user review, never last-write-wins.
- Annotated excluded totals remain in history without blocking safe exclusion.
- No new bank login, connector rewrite, or unrelated UI changes unless necessary
  to satisfy the explicitly required retention acceptance check.
- If a required user decision remains, present its exact evidence and pause that
  application; do not claim completion by bypassing the guard.

## Execution status

- Implemented and pushed the commit/reimport original-integrity guard, production
  staging/backup tests, revision-bound refresh previews, mapping preservation,
  annotation transfer/history, source-bound overlap review, and parser repairs.
- Applied all 998 active derivations to the live dev database after a verified
  backup and private apply/reapply test. The ledger has 12,449 transactions;
  balances did not change. Existing mappings and annotation values survived.
- Transferred 54 annotations using source evidence; retained 99 excluded-summary
  annotations in accessible history. No annotation review blockers remain.
- Verified no-op refreshes, a fresh-process private restart, and one retained-file
  repeat-import check for each of the seven current connections. All seven said
  nothing new; this is not a fresh user-driven bank-button run.
- Additional retention audit recovered 22 originals from the documented Downloads
  staging folder and reconstructed three inactive CSVs to their exact stored
  checksums. All 998 active source files now have originals; the two approved
  replacements remain historical evidence but are no longer required inputs.
- Implemented and regression-tested recovery-root coverage and derivation input
  checksum tracking. Reparsed the two recovered originals on private and live
  databases: ledger unchanged, subsequent refresh a no-op.
- Verified the missing inactive Vanguard export was fully represented by retained
  activity and monthly statements. At the user's explicit request, backed up and
  removed that inactive import and its parsed rows; ledger and annotations unchanged.
- Recovery follow-up acceptance passed: 713 backend tests, 18 frontend tests,
  typecheck, lint, and stable/dev desktop builds. Both bundles verified Bun 1.4.0
  with no Hutch or Cottontail runtime files. Launched the rebuilt dev app against
  the existing database. Account reconciliation is not in scope per user direction.

Remaining gates:

1. Finish the visual history check when the Mac is unlocked. The rebuilt app was
   launched, but Computer Use reported the Mac locked at the visual-check step.
2. The user starts a fresh app-button download/import to complete the final
   original-retention acceptance check; do not substitute a backend invocation.
