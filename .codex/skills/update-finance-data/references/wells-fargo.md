# Wells Fargo

## Catch-up workflow

The reusable script downloads posted CSV activity plus available statement PDFs
for the checking account and two credit accounts from a persistent headed
session:

```sh
bun .codex/skills/update-finance-data/scripts/wells-fargo.ts \
  --from 2026-05-29 --to YYYY-MM-DD \
  --output /private/tmp/easymoney-wells-fargo-catchup \
  --session wells-fargo-catchup
```

The default start date is `2026-05-29`, preserving the requested overlap. The
script is resumable: an existing CSV or statement PDF is reused only after it
passes the corresponding EasyMoney Wells Fargo parser. Use `--clean-run` to
remove only the expected Wells Fargo CSV/PDF artifacts in the private staging
directory before a timed download. Use `--validate-only` to validate completed
artifacts without using the browser.

The browser flow opens each account's **Download Account Activity** page, keeps
CSV selected, fills the requested date range, and downloads posted
transactions. It then opens **View Statements**, retrieves each in-range
statement plus the latest pre-window statement as an opening balance anchor,
and validates every artifact locally. Generic filenames omit account numbers,
so EasyMoney import requires explicit account mapping in preview. No account
numbers, balances, credentials, cookies, tokens, page contents, or transaction
contents are written to logs or this staging plan.

## Parser and import notes

The downloaded files are:

- `wells-fargo-checking.csv`
- `wells-fargo-autograph-visa.csv`
- `wells-fargo-platinum-card.csv`
- `wells-fargo-checking-statement-YYYY-MM-DD.pdf`
- `wells-fargo-autograph-visa-statement-YYYY-MM-DD.pdf`
- `wells-fargo-platinum-card-statement-YYYY-MM-DD.pdf`

Each file must match the EasyMoney Wells Fargo generic activity CSV parser and
contain at least one posted transaction before the script reports readiness.
Each account must also have at least one statement parsed by EasyMoney's Wells
Fargo statement parser with a nonzero balance anchor. Saved statement filenames
remain PII-free; the checking parser's required dated normalized filename is
supplied only as an in-memory validation path.
The parser accepts the observed header shape `Date,Description,Amount,CHECK
#,Status`. Overlapping exports are expected and should be committed through
EasyMoney's source-fact dedupe flow rather than edited in the files.

## Current site path

After sign-in, open **Accounts**, choose an account, then choose **Download
Account Activity**. Select **CSV**, set the date range, and choose **Download**.
The current site offers posted activity for up to 25 months. The exact labels
and account display names are treated as mutable; the script matches only the
generic account-kind labels and checks that each match is unique.
Statement controls must have unique dates. Missing or ambiguous account
matches, statement dates, PDF responses, or balance anchors fail closed.

## Gaps

- Generic filenames intentionally omit account numbers; confirm the three
  account mappings in the EasyMoney import preview.
- Pending transactions are excluded because the catch-up source is posted
  activity.
