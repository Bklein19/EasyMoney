export function needsImportUpdateReview(status: { running: boolean; error?: string | null; issues: readonly unknown[] } | undefined): boolean {
  return Boolean(status && !status.running && (status.error || status.issues.length));
}
