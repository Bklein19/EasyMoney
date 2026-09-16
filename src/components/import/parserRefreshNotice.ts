export function needsImportUpdateReview(status: { running: boolean; error?: string | null; issues: readonly unknown[] } | undefined): boolean {
  return Boolean(status && !status.running && (status.error || status.issues.length));
}

export function recategorizationNotice(history: readonly { id: number; ledgerTransactionId: string; disposition: string }[]) {
  const rows = history.filter(row => row.disposition === 'recategorization-needed');
  return { revision: Math.max(0, ...rows.map(row => row.id)), count: new Set(rows.map(row => row.ledgerTransactionId)).size };
}
