# Parser refresh

Original imported bytes and confirmed user choices are durable. Parsed facts and
the materialized ledger are versioned derivations.

Desktop builds and the web development/API commands generate a per-parser SHA-256
fingerprint from its local runtime dependency graph and installed direct package
versions. Shared adapters invalidate their dependent parsers. A regression test
rejects a stale checked-in manifest. Run `bun scripts/parser-versions.ts` after
editing parsers; packaged builds include the manifest and need no source tree.

On startup, EasyMoney recovers originals from the established legacy
`~/src/money/imports/raw` store and its connector sync-run store. New uploads and
connector staging retain bytes inside SQLite, included in database backups.
Recovery checks byte hashes, or the historical decoded-text hash plus original
filename. Conflicting byte candidates for a lossy historical hash are not selected.
The historical import hash is preserved; retained bytes have a separate checksum.
No source files on disk are deleted or rewritten.

Only committed imports whose parser fingerprint changed are reparsed. Unknown
versions are reparsed, never assumed current. Inactive imports remain inactive.
Custom/unregistered parsers require review until they have a versioned registered
implementation. Missing originals, parsing errors, invalid facts, and changed or
unresolved account identities retain their previous facts and appear on Import.

Before applying valid candidates, refresh verifies that source facts, mappings,
annotations, accounts, and materialized rows have not changed during parsing and
creates a `before-parser-refresh` database snapshot. One SQLite transaction
archives previous parsed facts, replaces candidate derivations, calculates and
validates the ledger, then materializes it and records successful fingerprints.
Conflicting balances, ambiguous transaction matches, or stranded annotations
roll back the entire candidate transaction. Exact stable annotation identities
survive; annotations are never reassigned by date/amount alone. Unrelated files
retain their parsed facts (the shared ledger is recalculated).

The Import page lists review-required files and offers retry. Resolve identity or
parser issues first; retry is not a force/ignore-validation button. Restore the
pre-refresh snapshot from Backups to roll back both facts and ledger; current user
choices should be backed up before restoring an older snapshot. Archived per-file
derivations remain available for diagnostics, including versions that were replaced.

No bank session or re-download is required when the original is available.
