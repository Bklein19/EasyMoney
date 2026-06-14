import { useState, useCallback } from 'react';

function optionBoolean(options, key, defaultValue = false) {
  return typeof options[key] === 'boolean' ? options[key] : defaultValue;
}

export function useCSVImport() {
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState(null);

  const processImport = useCallback(async (file, customProfile = null, options = {}) => {
    const inferCategories = optionBoolean(options, 'inferCategories', true);
    setIsParsing(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('inferCategories', String(inferCategories));
      if (customProfile) {
        formData.append('profileJson', JSON.stringify(customProfile));
      }

      const response = await fetch('/api/app/imports/preview', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        throw new Error(details.error || `Import preview failed: ${response.status}`);
      }

      return response.json();
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setIsParsing(false);
    }
  }, []);

  return { processImport, isParsing, error };
}
