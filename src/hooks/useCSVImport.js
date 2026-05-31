import { useState, useCallback } from 'react';
import Papa from 'papaparse';
import { detectBank, enhanceProfileWithHeaders, normalizeTransaction } from '../utils/bankProfiles';
import { categorizeTransactions } from '../utils/categorizer';
import { useCategories } from './useCategories';

export function useCSVImport() {
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState(null);
  const { rules, categories } = useCategories();

  const parseCSV = useCallback((file) => {
    return new Promise((resolve, reject) => {
      setIsParsing(true);
      setError(null);

      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        worker: true, // Use background worker for performance
        complete: (results) => {
          setIsParsing(false);
          if (results.errors && results.errors.length > 0) {
            // Some CSVs have trailing empty cols that cause errors, let's filter those
            const fatalErrors = results.errors.filter(e => e.type !== 'FieldMismatch');
            if (fatalErrors.length > 0) {
              setError(fatalErrors[0].message);
              reject(fatalErrors[0]);
              return;
            }
          }
          resolve(results);
        },
        error: (err) => {
          setIsParsing(false);
          setError(err.message);
          reject(err);
        }
      });
    });
  }, []);

  const processImport = useCallback(async (file, customProfile = null, options = {}) => {
    const inferCategories = options.inferCategories !== false;
    try {
      const parsed = await parseCSV(file);
      if (!parsed.data || parsed.data.length === 0) {
        throw new Error("No data found in CSV");
      }

      const headers = parsed.meta.fields || Object.keys(parsed.data[0]);
      const detectedProfile = detectBank(headers, file.name);
      const profile = customProfile || enhanceProfileWithHeaders(detectedProfile, headers);

      if (!profile) {
        // Need manual mapping
        return { 
          requiresMapping: true, 
          headers,
          previewData: parsed.data.slice(0, 5)
        };
      }

      // Normalize transactions based on profile
      let normalized = parsed.data
        .map(row => normalizeTransaction(row, profile))
        .filter(t => t !== null);

      if (normalized.length === 0) {
        throw new Error("Could not parse any valid transactions from this file.");
      }

      // Auto-categorize
      if (inferCategories && rules && categories) {
        normalized = categorizeTransactions(normalized, rules, categories);
      }

      return {
        requiresMapping: false,
        profileUsed: profile.name,
        profile,
        headers,
        previewData: parsed.data.slice(0, 5),
        inferCategories,
        transactions: normalized
      };
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [parseCSV, rules, categories]);

  return { processImport, isParsing, error };
}
