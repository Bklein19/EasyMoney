import { apiAction } from '../db/api';
import { useApiTable } from './useApiTable';

export function useImportProfiles() {
  const importProfiles = useApiTable('importProfiles');

  async function saveImportProfile({ headerSignature, profileName, profile, mapping, lastAccountId }) {
    return apiAction('/importProfiles/upsert', {
      method: 'POST',
      body: JSON.stringify({
        headerSignature,
        profileName,
        profileJson: JSON.stringify(profile),
        mappingJson: JSON.stringify(mapping),
        lastAccountId
      })
    });
  }

  return { importProfiles, saveImportProfile };
}
