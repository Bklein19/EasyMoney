import { Link } from 'react-router';
import {
  ArrowLeftRight,
  BarChart3,
  CheckCircle2,
  CreditCard,
  FileSpreadsheet,
  FolderInput,
  Layers3,
  Plus,
  Tags,
  WalletCards
} from 'lucide-react';
import './HowToUsePage.css';

const setupSteps = [
  {
    title: 'Create accounts first',
    description: 'Add one account for each place you import from. Use Credit Card for card statements so payments are treated as card payments instead of income.',
    icon: WalletCards,
    action: { to: '/accounts', label: 'Open Accounts' }
  },
  {
    title: 'Import one file at a time',
    description: 'Upload the CSV, confirm the detected format, pick the matching account, then import. EasyMoney remembers the account and mapping for repeat uploads with the same format.',
    icon: FolderInput,
    action: { to: '/import', label: 'Open Import' }
  },
  {
    title: 'Review categories',
    description: 'Most common transactions are categorized automatically. Anything left uncategorized can be fixed from Transactions or from an analytics drilldown.',
    icon: Tags,
    action: { to: '/transactions', label: 'Open Transactions' }
  },
  {
    title: 'Analyze without double counting',
    description: 'Internal Transfer and Investment categories are excluded from spending and net flow. Credit card charges still count as spending, while card payments do not.',
    icon: BarChart3,
    action: { to: '/analytics', label: 'Open Analytics' }
  }
];

const categoryTips = [
  'Use the Transactions page filters to isolate uncategorized rows, then apply a category to the filtered set.',
  'In Analytics, click a category, merchant, income stream, or time period to open a drilldown.',
  'Use the drilldown bulk category editor when a visible set should all become the same category.',
  'Create custom categories when the defaults do not match how you think about your money.',
  'Use Internal Transfer for money movement between your own accounts, including credit card payments.',
  'Use Investment for brokerage transfers or investing activity that should not reduce net flow.'
];

function MiniAccountsScreenshot() {
  return (
    <div className="howto-shot howto-shot--accounts" aria-label="Example empty accounts page">
      <div className="howto-shot__topbar">
        <div>
          <span className="howto-shot__eyebrow">Accounts</span>
          <strong>Manage your financial accounts</strong>
        </div>
        <span className="howto-shot__button"><Plus size={14} /> Add Account</span>
      </div>
      <div className="howto-shot__balance">
        <span>Total Net Balance</span>
        <strong>$0.00</strong>
      </div>
      <div className="howto-empty-box">
        <WalletCards size={32} />
        <strong>No accounts added yet.</strong>
        <span>Add checking, savings, credit cards, and investment accounts before importing.</span>
      </div>
    </div>
  );
}

function MiniImportScreenshot() {
  return (
    <div className="howto-shot howto-shot--import" aria-label="Example import review">
      <div className="howto-import-drop">
        <FileSpreadsheet size={26} />
        <strong>Drop CSV file here</strong>
        <span>Wells Fargo, Chase, Amex, Apple Card, and custom CSVs</span>
      </div>
      <div className="howto-import-review">
        <div>
          <span>Import to Account</span>
          <strong>WF Active Cash Card</strong>
        </div>
        <span className="howto-badge">Credit card mode</span>
      </div>
      <div className="howto-import-stats">
        <span>Charges</span>
        <span>Payments</span>
        <span>Duplicates skipped</span>
      </div>
    </div>
  );
}

function MiniCategorizeScreenshot() {
  return (
    <div className="howto-shot howto-shot--categorize" aria-label="Example categorization workflow">
      <div className="howto-filter-row">
        <span>Category</span>
        <strong>Uncategorized</strong>
        <span>Search</span>
        <strong>costco</strong>
      </div>
      <div className="howto-transaction-row">
        <span>COSTCO WHSE</span>
        <strong>-$84.12</strong>
      </div>
      <div className="howto-transaction-row">
        <span>COSTCO GAS</span>
        <strong>-$45.33</strong>
      </div>
      <div className="howto-bulk-action">
        <Tags size={16} />
        <span>Apply Groceries to 2 filtered transactions</span>
      </div>
    </div>
  );
}

function MiniAnalyticsScreenshot() {
  return (
    <div className="howto-shot howto-shot--analytics" aria-label="Example analytics drilldown">
      <div className="howto-category-line">
        <span>Food & Dining</span>
        <div><i style={{ width: '78%' }} /></div>
        <strong>$1,240</strong>
      </div>
      <div className="howto-category-line">
        <span>Shopping</span>
        <div><i style={{ width: '52%' }} /></div>
        <strong>$830</strong>
      </div>
      <div className="howto-drilldown-preview">
        <div>
          <strong>Food & Dining Spending</strong>
          <span>Filtered total -$1,240.00</span>
        </div>
        <span className="howto-badge">Bulk edit</span>
      </div>
    </div>
  );
}

export default function HowToUsePage() {
  return (
    <div className="page howto-page">
      <header className="page__header howto-header">
        <div>
          <h1 className="page__title">How To Use EasyMoney</h1>
          <p className="page__subtitle">A practical setup guide for importing, cleaning, and analyzing local finance data.</p>
        </div>
      </header>

      <section className="howto-hero glass-card">
        <div className="howto-hero__content">
          <span className="howto-kicker">Recommended first run</span>
          <h2>Accounts, then imports, then cleanup.</h2>
          <p>
            EasyMoney works best when each CSV lands in the correct account. After import, use filters and bulk category tools to clean up anything automatic categorization missed.
          </p>
        </div>
        <MiniAccountsScreenshot />
      </section>

      <section className="howto-grid" aria-label="Setup steps">
        {setupSteps.map((step, index) => (
          <article className="howto-step glass-card" key={step.title}>
            <div className="howto-step__icon">
              <step.icon size={20} />
            </div>
            <span className="howto-step__number">Step {index + 1}</span>
            <h2>{step.title}</h2>
            <p>{step.description}</p>
            <Link className="btn btn--secondary btn--sm" to={step.action.to}>{step.action.label}</Link>
          </article>
        ))}
      </section>

      <section className="howto-workflow">
        <article className="howto-workflow__item">
          <div>
            <span className="howto-kicker">1. Start clean</span>
            <h2>Create the destination account before uploading a CSV</h2>
            <p>
              A checking statement should go to a checking account. A Wells Fargo Active Cash or Autograph statement should go to a credit card account. New accounts default to a $0 balance, so you can create them quickly and adjust later.
            </p>
          </div>
          <MiniAccountsScreenshot />
        </article>

        <article className="howto-workflow__item">
          <div>
            <span className="howto-kicker">2. Import and review</span>
            <h2>Confirm the account, mapping, duplicate handling, and credit card mode</h2>
            <p>
              The import preview shows how many rows were found, whether duplicates will be skipped, and whether the selected account is using credit card behavior. Use Review Mapping when a file has unusual columns.
            </p>
          </div>
          <MiniImportScreenshot />
        </article>

        <article className="howto-workflow__item">
          <div>
            <span className="howto-kicker">3. Fix categories in batches</span>
            <h2>Use filtered-set bulk categorization instead of editing one row at a time</h2>
            <p>
              Filter to Uncategorized, search for a merchant or keyword, then apply a category to the filtered set. EasyMoney warns before large bulk edits so accidental changes are easier to catch.
            </p>
          </div>
          <MiniCategorizeScreenshot />
        </article>

        <article className="howto-workflow__item">
          <div>
            <span className="howto-kicker">4. Drill into analytics</span>
            <h2>Click chart rows to open the exact transactions behind a number</h2>
            <p>
              Spending categories, merchants, income streams, and chart periods can open a drilldown. Drilldowns include a filtered total, search, sort, infinite scroll, and bulk category editing.
            </p>
          </div>
          <MiniAnalyticsScreenshot />
        </article>
      </section>

      <section className="howto-cleanup glass-card">
        <div className="howto-cleanup__header">
          <Layers3 size={20} />
          <div>
            <h2>Cleanup Rules Of Thumb</h2>
            <p>Use these labels consistently so analytics stay readable.</p>
          </div>
        </div>
        <div className="howto-tip-grid">
          {categoryTips.map((tip) => (
            <div className="howto-tip" key={tip}>
              <CheckCircle2 size={16} />
              <span>{tip}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="howto-reference">
        <div className="howto-reference__card glass-card">
          <CreditCard size={20} />
          <h2>Credit card imports</h2>
          <p>Charges are spending. Payments to the card are card payments or internal money movement, not income.</p>
        </div>
        <div className="howto-reference__card glass-card">
          <ArrowLeftRight size={20} />
          <h2>Internal transfers</h2>
          <p>Use Internal Transfer for money moving between your own accounts so it does not inflate income or expenses.</p>
        </div>
        <div className="howto-reference__card glass-card">
          <BarChart3 size={20} />
          <h2>Investments</h2>
          <p>Use Investment for brokerage transfers. Investments get their own analytics tile and do not reduce net flow.</p>
        </div>
      </section>
    </div>
  );
}
