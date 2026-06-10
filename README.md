# Personal Finance Observatory

A self-hosted personal finance data platform focused on long-term wealth tracking, savings rate analysis, and financial observability.

This is **not** a budgeting application. The goal is a durable, queryable historical record of your financial life — answering high-level questions about wealth creation over time, not categorizing spending or managing envelopes.

---

## Core Goals

### Data Ownership

All imported data is stored locally. Raw source files (CSV, OFX, QFX, PDF, etc.) are preserved indefinitely. Historical data is never lost if a bank, aggregator, or third-party service disconnects.

### Historical Reconstruction

Reconstruct financial history as far back as practical (target: 2018–present) from:

- Bank and credit card transaction exports
- Brokerage and retirement account exports
- Tax documents, W-2s, and pay stubs
- Historical statements and manual imports

The system tolerates incomplete historical data and improves accuracy as more sources are imported.

### Net Worth Tracking

Track assets, liabilities, and net worth over time with monthly, quarterly, and annual snapshots. Generate net worth history charts and reports.

### Savings Rate Analysis

First-class feature. For each month, quarter, and year:

- Gross income
- Savings
- Savings rate (gross, net, with/without employer match)

### Wealth Attribution

Break net worth growth into its sources:

| Source | Example |
|---|---|
| Contributions/savings | $42,000 |
| Market returns | $18,000 |
| Employer match | $4,000 |
| **Total growth** | **$64,000** |

### Cash Flow

Answer: how much did I earn, save, spend, and what percentage of income became assets? Detailed spending categorization is not required.

### Investment Tracking

Track holdings, contributions, cost basis, dividends, and investment performance. Reconstruct investment returns versus new contributions.

---

## Query Layer

The data model is designed so an LLM/MCP interface can answer questions like:

- What was my savings rate in 2021?
- How much of my net worth growth came from market returns?
- When did my investment returns first exceed my annual savings?
- How has my savings rate changed over time?
- How much have I contributed to taxable accounts since 2018?
- What percentage of my wealth came from earned income versus investment gains?

---

## Stack

- **Bun** — runtime, package manager, and test runner
- **TypeScript** — type-safe throughout
- **SQLite** (via `bun:sqlite`) — local, portable, zero-dependency storage
- **HTML UI** — served by Bun's built-in HTTP server

## Architecture

- **Local-first** — all data stays on your machine
- **Append-only raw imports** — source files preserved with provenance
- **Idempotent import pipeline** — safe to re-run
- **API-first** — structured for LLM/MCP integration
- **Self-hostable** — no external dependencies required

---

## Non-Goals

The following are explicitly out of scope:

- Envelope budgeting
- Subscription management
- Expense guilt dashboards
- Credit score monitoring
- Bill reminders
- Gamification
- Cashback optimization
