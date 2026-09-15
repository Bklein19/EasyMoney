# Transfer records

All transfer reporting goes through `deriveTransferLinks`: heuristic matches and
confirmed transfers produce the same record shape and contribution/gain
adjustments. Investment reports do not apply separate closure adjustments.

## Durable decisions versus derived evidence

`transferRecords` stores confirmed user decisions: stable ID, source account,
optional destination, effective date, reason, confirmation/revocation state, and
timestamps. The initial supported confirmation is a reporting closure. Reopening
revokes its record; it does not delete the decision. Reporting's zero-balance
assertion remains in `accounts.reportingClosedOn`.

Heuristic matches are recomputed from imported facts, not saved as user approval.
The report returns both kinds in `transfer_links`, with `confirmation`,
`evidence_status`, effective date, account IDs, transaction evidence, and derived
amount/basis/gain fields. An unpriced confirmed transfer has `amount_cents: null`;
its historical basis/gain allocation is not proof of its transfer-date valuation.

When uniquely matching dated bank evidence arrives, the inferred match adopts
the confirmed record's ID and is returned once, as `matched`. Adjustments are
applied once. Matching checks account pair and date window, not merely whether
those accounts have ever transferred before. Conflicting evidence is marked
`conflict`, not silently attached to a confirmation.

The migration moves prior closure destinations out of the accounts table into
`transferRecords`. Backups preserve confirmed and revoked records. Raw imported
facts and materialized transaction history are not rewritten by the migration.
