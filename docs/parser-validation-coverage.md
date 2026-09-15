# Parser validation coverage

These are developer/import-integrity checks, not a user reconciliation dashboard. No totals are emitted as transactions. Failures reject parser output before staging; refresh retains prior facts on parse failure. Original bytes and annotations are not changed by validation.

| Statement parser | Implemented check | Limitation |
| --- | --- | --- |
| BofA deposit and card | Printed opening/closing balance and separate credit/debit totals | Requires recognized summary |
| Wells deposit and card | Printed opening/closing balance and separate credit/debit totals | Requires recognized summary |
| Marcus | Printed opening/closing balance and separate credit/debit totals | Interest already included in credits |
| TIAA | Portfolio roll-forward including fees and gains/losses; closing balance corroboration | Does not establish transaction completeness |
| Merrill CMA | Portfolio roll-forward including transfers and market movement | Does not establish transaction completeness |
| Morgan Stanley | Net flows plus change in value; closing balance corroboration | Supported printed summary format only |
| Fidelity NetBenefits PDF / 401(k) HTML | Simple explicit contribution/market-movement roll-forward | Full legacy HTML with other movement categories remains unavailable |
| Fidelity portfolio | Printed contribution/distribution section totals | Securities-transfer cash total is not a market-value total |
| Fidelity investment report | Recognized dated external-flow row coverage | Not all brokerage activity or statement arithmetic |
| Vanguard statement | Recognized completed-transaction row coverage | No assertion about totals or market movement |
| Sequoia | Recognized purchase-row coverage | Reinvestments and market movement are outside this check |
| Robinhood banking/card | Recognized activity-row coverage | No independent totals check; synthetic fixtures only |
| Robinhood brokerage | Recognized supported cash-activity row coverage | Share-only ACAT rows excluded; synthetic fixtures only |

Activity CSV/API/HTML exports without independent printed summary evidence are not statement-total validation candidates. Their protocol/shape/account tests remain separate. A zero-row or unsupported check must not report a pass.

## Retained-source replay

```sh
bun scripts/validate-retained-statements.ts /absolute/path/to/database.sqlite
```

This command opens SQLite read-only in a snapshot transaction, checks original-byte hashes, invokes the production parser registry, and removes only its own temporary extraction files. It does not initialize/migrate the application database, commit imports, refresh derivations or access banks. Output contains parser IDs, safe failure categories and aggregate counts, not private document contents. A validation/parser/integrity failure yields nonzero exit status. `unavailable` is not success.

Replay on the existing 954 committed statement originals found 476 transaction-total passes, 169 balance-summary passes, 179 recognized-row passes and 130 unavailable checks, with no failures. The unavailable group consists of 88 legacy Fidelity HTML files and 42 documents without recognized activity rows. Fidelity portfolio, NetBenefits PDF and Robinhood changes have synthetic regression evidence but no retained-source replay coverage in this database.

The new checks exposed and led to a BofA fix: side-by-side check tables (including blank check-number cells) must produce separate transactions. These source corrections have not been applied to the live ledger. Review an isolated refresh candidate before deployment; parser dependency fingerprints intentionally change.

## Acceptance scope

Keep three levels distinct: numeric statement totals, investment summary arithmetic, and recognized-row coverage. None proves every account is reconciled against independent truth. No fresh connector run or app-button test is claimed. Normal desktop packaging has stalled on this worktree; do not treat client build success as desktop acceptance.
