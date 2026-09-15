# Statement cash-flow evidence

Fidelity 401(k) HTML and TIAA quarterly statements retain period contribution
totals in `sourceBalances.rawJson.statementCashFlow`. The original bytes remain
the durable source; this metadata is refreshed with the parser derivation.

These totals are not transactions and never enter spending, transaction search,
categorization, or transaction deduplication. TIAA uses the first (quarterly)
summary column, including employer contributions and net other credits/debits;
fees remain part of the net investment result.

The investment report uses each period total once, subtracting classified
contribution events already represented within the exact period. Any remainder
is applied at period end for reporting only, without claiming individual event
dates. Identical period evidence deduplicates; contradictory totals or overlapping
nonidentical periods require review and prevent parser refresh from committing.

This does not reconstruct missing daily cash-flow dates for IRR, nor infer
contributions from arbitrary fund purchases. Existing opening-balance seeding
still applies when history begins partway through an account's lifetime.
