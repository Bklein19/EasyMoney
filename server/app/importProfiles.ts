import { getDb, insertRow, listRows, updateRow } from '../database.js';

export function listImportProfiles() {
  return listRows('importProfiles');
}

export function upsertImportProfile(input: {
  headerSignature: string;
  profileName?: string | null;
  profileJson: string;
  mappingJson?: string | null;
  lastAccountId?: number | string | null;
}) {
  const now = new Date().toISOString();
  const existing = getDb().prepare('SELECT id FROM importProfiles WHERE headerSignature = ?').get(input.headerSignature) as
    | { id: number }
    | undefined;

  const row = {
    headerSignature: input.headerSignature,
    profileName: input.profileName ?? null,
    profileJson: input.profileJson,
    mappingJson: input.mappingJson ?? null,
    lastAccountId: input.lastAccountId ?? null,
    updatedAt: now,
  };

  if (existing) {
    updateRow('importProfiles', existing.id, row);
    return { id: existing.id };
  }

  const id = Number(insertRow('importProfiles', {
    ...row,
    createdAt: now,
  }));
  return { id };
}
