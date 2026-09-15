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
| Fidelity NetBenefits PDF / 401(k) HTML | Bounded opening-to-closing summary, contributions, fees and market movement; omitted zero rows supported | Unknown summary categories remain unavailable; navigation is outside the check |
| Fidelity portfolio | Printed contribution/distribution section totals | Securities-transfer cash total is not a market-value total |
| Fidelity investment report | Account-value roll-forward and closing balance, plus recognized external-flow row coverage | Balance arithmetic does not establish transaction completeness; costs are nested in subtractions |
| Vanguard statement | Recognized completed-transaction row coverage, or a bounded entirely empty activity table | No assertion about totals or market movement; nonempty unrecognized tables never pass as empty |
| Sequoia | Every printed share movement and running share total, closing balance, purchase-row count | Reinvestment shares are checked but not emitted as external-flow transactions; not a cash-total check |
| Robinhood banking/card | Recognized activity-row coverage | No independent totals check; synthetic fixtures only |
| Robinhood brokerage | Recognized supported cash-activity row coverage | Share-only ACAT rows excluded; synthetic fixtures only |

Activity CSV/API/HTML exports without independent printed summary evidence are not statement-total validation candidates. Their protocol/shape/account tests remain separate. A zero-row or unsupported check must not report a pass.

## Retained-source replay

```sh
bun scripts/validate-retained-statements.ts /absolute/path/to/database.sqlite --require-coverage
```

This command opens SQLite read-only in a snapshot transaction, checks original-byte hashes, invokes the production parser registry, and removes only its own temporary extraction files. It does not initialize/migrate the application database, commit imports, refresh derivations or access banks. Output contains parser IDs, safe failure categories and aggregate counts, not private document contents. A validation/parser/integrity failure yields nonzero exit status. `--require-coverage` also fails on unavailable checks. Without that option unavailable remains diagnostic, never a pass.

Replay of all 954 committed statement originals on 2026-09-14 found **zero unavailable checks and zero failures**:

| Evidence | Statements |
| --- | ---: |
| Separate transaction totals and balance arithmetic | 476 |
| Investment balance-summary arithmetic | 325 |
| Share roll-forward and closing balance | 34 |
| Recognized completed-transaction row coverage | 112 |
| Explicitly empty completed-transaction table | 7 |

The former 130 unavailable results were resolved by bounding the 88 legacy Fidelity HTML summaries, adding Fidelity account-value arithmetic, validating Sequoia share movements (including reinvestments and explicit no-activity periods), and recognizing Vanguard's entirely empty bounded table. This is coverage of the retained corpus, not a guarantee that all future formats are supported. Fidelity portfolio, NetBenefits PDF and Robinhood changes have synthetic regression evidence but no retained-source replay coverage in this database.

The new checks exposed and led to a BofA fix: side-by-side check tables (including blank check-number cells) must produce separate transactions. These source corrections have not been applied to the live ledger. Review an isolated refresh candidate before deployment; parser dependency fingerprints intentionally change.

## Acceptance scope

Keep the evidence levels distinct: numeric statement totals, investment summary arithmetic, share roll-forward, recognized-row coverage, and an explicitly empty table. None proves every account is reconciled against independent truth. No fresh connector run or app-button test is claimed. Normal desktop packaging has stalled on this worktree; do not treat client build success as desktop acceptance.

Latest acceptance: 745 tests passed, TypeScript checking and lint passed, client build passed, and strict retained-original replay exited successfully. The normal desktop build was attempted with runtime access but stalled without progress and was stopped; the running dev app and live ledger were left untouched.
