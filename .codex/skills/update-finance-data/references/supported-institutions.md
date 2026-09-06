# Supported Institutions

This reference tracks what EasyMoney can currently import. Exact website click paths should be updated as real download runs happen.

## General Catch-Up Order

1. Checking and savings activity CSVs.
2. Credit-card activity CSVs.
3. Brokerage and retirement activity exports.
4. Latest missing monthly or quarterly statements for balances.
5. Import all staged files into EasyMoney, then run `/transactions/review`.

## Bank of America

Supported:
- Activity CSV for checking/savings.
- Statement PDF for checking/savings/credit card.

Useful parser filenames:
- `bofa-checking-1234-2026-01-01-to-2026-06-30.csv`
- `bofa-savings-1234-2026-01-01-to-2026-06-30.csv`
- `bofa-checking-1234-2026-june-statement.pdf`
- `bofa-savings-1234-2026-june-statement.pdf`
- `bofa-credit-card-1234-2026-june-statement.pdf`

Notes:
- Activity CSVs can also be recognized by content when they start with Bank of America export headers.
- Prefer activity CSV for transaction detail.
- Statements provide balance anchors and may include statement-summary rows when exact transaction detail is unavailable.

## Chase

Supported:
- Credit-card activity CSV.

Expected headers:
- `Transaction Date`
- `Post Date`
- `Description`
- `Category`
- `Type`
- `Amount`

Notes:
- Download activity CSV over the desired catch-up window.
- Account mapping may be manual because the parser does not infer a specific account from the CSV alone.

## Wells Fargo

Supported:
- Activity CSV.
- Statement PDF for checking and credit cards.

Useful parser filenames:
- `wells-fargo-checking-1234-2026-01-01-to-2026-06-30.csv`
- `wells-fargo-autograph-visa-1234-2026-01-01-to-2026-06-30.csv`
- `wells-fargo-platinum-card-1234-2026-01-01-to-2026-06-30.csv`
- `wells-fargo-checking-1234-2026-06-30.pdf`
- `wells-fargo-autograph-visa-1234-2026-06-30.pdf`
- `wells-fargo-platinum-card-1234-2026-06-30.pdf`

Generic CSV recognition:
- Headers like `Date, Description, Amount, CHECK #, Status` are supported even without a normalized filename.

Notes:
- If the normalized filename is available, use it to improve account inference.
- Activity exports should overlap safely.

## Vanguard

Supported:
- Activity PDF.
- Statement PDF.

Useful parser filenames:
- `vanguard-1234-2026-01-01-to-2026-06-30-transaction-history.pdf`
- `vanguard-1234-2026-06-30-statement.pdf`
- `2026-06-30-Brokerage---Account.pdf`
- `2026-06-30-Roth-IRA---Account.pdf`
- `2026-06-30-Trad-IRA---Account.pdf`

Notes:
- Activity parser recognizes `customActivityReport.pdf` and transaction history PDFs with Vanguard content.
- Download activity for transaction detail and statements for balances.

## Fidelity

Supported:
- Fidelity 401(k) HTML statement.
- Fidelity NetBenefits PDF statement.
- Fidelity portfolio PDF statement.
- Fidelity investment report PDF.

Useful parser filenames:
- `fidelity-401k-examplepayroll-2026-06.html`
- `2026-06-June-ExampleCo-401k-Fidelity-NetBenefits-Statement.pdf`
- `2026-06-Account-Fidelity-Statement.pdf`
- `June-2026-Account-Fidelity-Statement.pdf`
- `fidelity-Z123-2026-06-30.pdf`

Notes:
- Prefer current PDF statements where available.
- The HTML parser exists for a specific 401(k) statement export shape.
- Investment reports may include RSU/ESPP/tax journal activity plus account value.

## Merrill

Supported:
- Activity CSV.
- CMA statement PDF.

Useful parser filenames:
- `merrill-activity-2026.csv`
- `SettledActivity_010126_063026.csv`
- `merrill-statement-2026-STMT_06302026_XXXXX12345_CMAEdge.pdf`

Notes:
- Activity CSV is preferred for transactions.
- Statement PDF can emit net cash flow summaries when detailed activity is not available.

## Morgan Stanley

Supported:
- Activity PDF.
- Statement PDF.

Useful parser filenames:
- `AllActivity.pdf`
- `morgan-stanley-1234-2026-06-30-statement.pdf`

Notes:
- `AllActivity.pdf` is the activity export parser.
- Statement parser handles monthly statements and intentionally skips annual/consolidated aggregate statements in some cases.

## TIAA

Supported:
- Activity CSV.
- Statement PDF.

Useful parser filenames:
- `tiaa-retirement-annuity-2026.csv`
- `tiaa-retirement-annuity-current-year-2026.csv`
- `tiaa-2026-06-30-retirement-q2-2026-1234.pdf`

Expected activity CSV header:
- `Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission`

Notes:
- Activity CSV is useful for contributions and transfers.
- Statement PDF provides retirement balance anchors.

## Marcus

Supported:
- Online savings statement PDF.

Useful parser filename:
- `marcus-online-savings-1234-2026-06-30-statement.pdf`

Notes:
- Statements include activity and ending balance.

## Robinhood

Supported:
- Brokerage statement PDF.
- Banking activity CSV and monthly statement PDF.
- Robinhood Gold Card activity CSV and monthly statement PDF.

Useful parser filenames:
- `robinhood-1234-2026-06-30-statement.pdf`
- UUID-style Robinhood statement PDFs are also recognized.
- UUID-style banking CSVs with `Date,Description,Amount` are recognized.
- Mobile bank statements named `Bank Statement ...pdf` are recognized by content.
- Mobile Gold Card statements named `Credit Statement ...pdf` are recognized by content.

Credit-card CSV expected headers:
- `Date`
- `Time`
- `Cardholder`
- `Amount`
- `Points`
- `Balance`
- `Status`
- `Type`
- `Merchant`
- `Description`

Notes:
- Statement parser recognizes individual investing and consolidated IRA statements by content.
- Robinhood Banking and Gold Card are mobile-export workflows. The dedicated connector scans the folder in `EASYMONEY_ROBINHOOD_EXPORT_DIR`, or the current user's Downloads folder when it is unset.
- Export the activity CSV for transaction detail and the monthly statement PDF for its closing balance. Both are useful; the connector selects the newest activity export and statements whose balance dates are missing.
- Gold Card activity imports only rows whose status is `Posted`; pending and declined rows are ignored.
- Banking and credit-card CSVs do not carry account numbers, so each account type must map to one unambiguous local Robinhood account. Statement account suffixes are used when available.

## Sequoia Fund

Supported:
- Activity CSV from History.
- Statement PDF.

Useful parser filename:
- `sequoia-fund-account-<account-token>-scope-key-<scope-hash>-activity-YYYY-MM-DD-to-YYYY-MM-DD.csv`
- `sequoia-fund-2026-06-30.pdf`

Notes:
- Each connector run targets one local Sequoia Fund account/login and requires exactly one login-level portfolio group from `portfolioJSON`.
- Activity is requested once at the aggregate portfolio level with direct history JSON and CSV HTTP requests; rendered dropdown entries are not treated as accounts or automation targets.
- The aggregate activity export and all statements retain the selected local account's canonical identity.
- Statements provide balance and purchase activity.

## Other CSV Profiles

Supported by legacy profile shape:
- American Express Credit Card CSV.
- Apple Card CSV.
- Capital One CSV.
- Citi CSV.
- Robinhood Credit Card CSV.

Notes:
- These are header-based parsers. If preview requires mapping, save the custom mapping only when the header shape is stable.
- American Express requires a filename containing `amex` or `american express`.
