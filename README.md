# EasyMoney

EasyMoney is a local-first personal finance dashboard for importing bank, credit card, and investment transactions from CSV files.

## Features

- Account, transaction, budget, net worth, and analytics views
- CSV import with bank/profile detection and manual column mapping
- Credit card transaction handling
- Duplicate detection for repeat imports
- Saved import profiles for repeated uploads with the same file format
- Local SQLite persistence through a small Express API

## How To Use EasyMoney

EasyMoney works best when you set up accounts first, import one CSV at a time, clean up categories in batches, and then use analytics and budgets for comparison.

### Recommended First Run

1. Create accounts first

   Add one account for each place you import from. Use `Credit Card` for card statements so payments are treated as card payments instead of income.

2. Import one file at a time

   Upload the CSV, confirm the detected format, pick the matching account, then import. EasyMoney remembers the account and mapping for repeat uploads with the same file format.

3. Review categories

   Most common transactions are categorized automatically. Anything left uncategorized can be fixed from Transactions or from an analytics drilldown.

4. Analyze without double counting

   `Internal Transfer` and `Investment` categories are excluded from spending and net flow. Credit card charges still count as spending, while card payments do not.

5. Save budget templates

   Design a monthly budget or save one from a real period, then apply it to months, years, or custom ranges for normalized comparisons.

### Workflow

#### 1. Start Clean

Create the destination account before uploading a CSV. A checking statement should go to a checking account. A Wells Fargo Active Cash or Autograph statement should go to a credit card account. New accounts default to a `$0` balance, so you can create them quickly and adjust later.

#### 2. Import And Review

Confirm the account, mapping, duplicate handling, and credit card mode. The import preview shows how many rows were found, whether duplicates will be skipped, and whether the selected account is using credit card behavior. Use Review Mapping when a file has unusual columns.

#### 3. Fix Categories In Batches

Use filtered-set bulk categorization instead of editing one row at a time. Filter to `Uncategorized`, search for a merchant or keyword, then apply a category to the filtered set. EasyMoney warns before large bulk edits so accidental changes are easier to catch.

#### 4. Drill Into Analytics

Click chart rows to open the exact transactions behind a number. Spending categories, merchants, income streams, and chart periods can open a drilldown. Drilldowns include a filtered total, search, sort, infinite scroll, and bulk category editing.

#### 5. Build A Budget Template

Use Design Budget to create a named monthly template, or Save Budget from This Period to turn the displayed month, year, or custom range into a normalized monthly plan. Applying a saved budget scales it automatically for year and custom views.

### Cleanup Rules Of Thumb

- Use the Transactions page filters to isolate uncategorized rows, then apply a category to the filtered set.
- In Analytics, click a category, merchant, income stream, or time period to open a drilldown.
- Use the drilldown bulk category editor when a visible set should all become the same category.
- Create custom categories when the defaults do not match how you think about your money.
- Use `Internal Transfer` for money movement between your own accounts, including credit card payments.
- Use `Investment` for brokerage transfers or investing activity that should not reduce net flow.

### Category Reference

- Credit card imports: Charges are spending. Payments to the card are card payments or internal money movement, not income.
- Internal transfers: Use `Internal Transfer` for money moving between your own accounts so it does not inflate income or expenses.
- Investments: Use `Investment` for brokerage transfers. Investments get their own analytics tile and do not reduce net flow.
- Budget templates: Saved budgets are monthly plans. EasyMoney scales them to the selected month, year, or custom period.

## Local Data

EasyMoney stores local app data in `data/easymoney.sqlite`. The `data/` folder is ignored by Git so personal transaction data is not committed.

## Development

```bash
npm install
npm run dev
```

The dev command starts both the API server and Vite frontend.

- Frontend: `http://localhost:5173`
- API: `http://localhost:4177`

## Build

```bash
npm run build
```
