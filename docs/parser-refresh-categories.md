# Categories during parser refresh

Validated parser updates do not pause solely because a category-only annotation
has no unique destination. The old annotation and its source evidence remain
durable in annotation history (`recategorization-needed`), with no category
copied to an uncertain replacement transaction. Existing annotations on other
transactions are not cleared. Import shows a compact, dismissible notice linking
to transactions and the saved choices, not a mandatory repair task.

The notice counts previous category assignments, not replacement transactions or
an outstanding task count. A split may produce multiple uncategorized rows.

Uncertain nonempty notes, conflicting categories or notes on a shared destination,
and collapsing distinct original occurrences still require review. Invalid facts,
uncertain account mappings, new overlap ambiguity, and conflicting balances retain
their existing transactional blocking behavior. Financial validation is independent
of whether a category can be carried forward.

Original annotations are never deleted. Stable identities and unambiguous source
occurrences continue to transfer categories and notes normally. Intentionally
excluded summaries remain in history rather than becoming recategorization tasks.
