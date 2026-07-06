import { useQuery } from '@tanstack/react-query';
import { queryClient, trpc, trpcClient } from '../api/trpc';

interface SaveImportProfileInput {
  headerSignature: string;
  profileName: string;
  profile: unknown;
  mapping: unknown;
  lastAccountId?: number | string | null;
}

export function useImportProfiles() {
  const importProfilesQuery = useQuery(trpc.importProfiles.list.queryOptions());

  async function saveImportProfile({ headerSignature, profileName, profile, mapping, lastAccountId }: SaveImportProfileInput) {
    const result = await trpcClient.importProfiles.upsert.mutate({
      headerSignature,
      profileName,
      profileJson: JSON.stringify(profile),
      mappingJson: JSON.stringify(mapping),
      lastAccountId,
    });
    await queryClient.invalidateQueries({ queryKey: trpc.importProfiles.list.queryKey() });
    return result;
  }

  return {
    importProfiles: importProfilesQuery.data ?? [],
    saveImportProfile,
    isLoading: importProfilesQuery.isLoading,
    isFetching: importProfilesQuery.isFetching,
    error: importProfilesQuery.error,
  };
}
