import { useCallback, useState } from 'react';

interface ImportProfile {
  name: string;
  statementType?: string;
  dateColumns?: string[];
  dateFormats?: string[];
  descriptionColumn?: string;
  merchantColumn?: string;
  categoryColumn?: string | null;
  amountConfig?: Record<string, unknown>;
}

interface ImportPreviewResult {
  importFileId?: number;
  requiresMapping: boolean;
  profileUsed?: string;
  profile?: ImportProfile;
  headers: string[];
  previewData?: Array<Record<string, string>>;
  mapping?: Record<string, unknown>;
  accountMappings?: Array<{
    sourceAccountId: number;
    institution: string | null;
    sourceAccountName: string | null;
    resolvedAccountId: number | null;
    resolution: string;
    transactionCount: number;
    balanceCount: number;
  }>;
  transactions?: unknown[];
}

export function useCSVImport() {
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const processImport = useCallback(async (
    file: File,
    customProfile: ImportProfile | null = null
  ): Promise<ImportPreviewResult | null> => {
    setIsParsing(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      if (customProfile) {
        formData.append('profileJson', JSON.stringify(customProfile));
      }

      const response = await fetch('/api/app/imports/preview', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        const details = await response.json().catch(() => ({} as { error?: string }));
        throw new Error(details.error || `Import preview failed: ${response.status}`);
      }

      return response.json() as Promise<ImportPreviewResult>;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Import preview failed';
      setError(message);
      return null;
    } finally {
      setIsParsing(false);
    }
  }, []);

  return { processImport, isParsing, error };
}
