import { useCallback, useState } from 'react';
import { trpcClient } from '../api/trpc';

export interface ImportProfile {
  name: string;
  statementType?: string;
  dateColumns?: string[];
  dateFormats?: string[];
  descriptionColumn?: string;
  merchantColumn?: string;
  categoryColumn?: string | null;
  amountConfig?: Record<string, unknown>;
}

export interface ImportPreviewResult {
  importFileId?: number;
  requiresMapping: boolean;
  profileUsed?: string;
  profile?: ImportProfile;
  headers: string[];
  previewData?: Array<Record<string, string>>;
  mapping?: unknown;
  savedImportProfile?: unknown;
  accountMappings?: Array<{
    sourceAccountId: number;
    institution: string | null;
    sourceAccountName: string | null;
    resolvedAccountId: number | null;
    resolvedAccountStatus?: string | null;
    resolution: string;
    transactionCount: number;
    balanceCount: number;
  }>;
  balanceRowIds?: number[];
  transactions?: Array<Record<string, unknown> & { importRowId: string | number }>;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function useCSVImport() {
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const processImport = useCallback(async (
    file: File,
    customProfile: ImportProfile | null = null,
    options: { throwOnError?: boolean } = {}
  ): Promise<ImportPreviewResult | null> => {
    setIsParsing(true);
    setError(null);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return await trpcClient.imports.preview.mutate({
        fileName: file.name || 'import.csv',
        text: new TextDecoder().decode(bytes),
        fileBase64: bytesToBase64(bytes),
        customProfile,
      }) as ImportPreviewResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Import preview failed';
      const fileLabel = file.webkitRelativePath || file.name || 'selected file';
      const labeledMessage = `${fileLabel}: ${message}`;
      setError(labeledMessage);
      if (options.throwOnError) {
        throw new Error(labeledMessage);
      }
      return null;
    } finally {
      setIsParsing(false);
    }
  }, []);

  return { processImport, isParsing, error };
}
