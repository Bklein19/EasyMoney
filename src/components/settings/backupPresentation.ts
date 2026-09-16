export type BackupSection = 'backups' | 'choices' | 'updates';
export function backupSection(section: string | null, legacyHistory: string | null): BackupSection {
  if (section === 'choices' || section === 'updates') return section;
  return legacyHistory === 'open' ? 'choices' : 'backups';
}
export function backupReason(id: string): string {
  if (id.includes('-before-parser-refresh-')) return 'Before an import update';
  if (id.includes('-before-migration-')) return 'Before a database upgrade';
  if (id.includes('-before-restore-')) return 'Before a restore';
  if (id.includes('-manual-')) return 'Manual backup';
  return 'Automatic backup';
}
