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
