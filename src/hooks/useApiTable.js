import { useEffect, useReducer, useState } from 'react';
import { list, subscribeToDataChanges } from '../db/api';

export function useApiTable(table, query = {}) {
  const [rows, setRows] = useState([]);
  const [refreshToken, refresh] = useReducer(value => value + 1, 0);
  const queryKey = JSON.stringify(query);

  useEffect(() => subscribeToDataChanges(refresh), []);

  useEffect(() => {
    let cancelled = false;
    const parsedQuery = JSON.parse(queryKey);
    list(table, parsedQuery)
      .then(data => {
        if (!cancelled) setRows(data);
      })
      .catch(error => {
        console.error(`Failed to load ${table}`, error);
        if (!cancelled) setRows([]);
      });

    return () => {
      cancelled = true;
    };
  }, [table, refreshToken, queryKey]);

  return rows;
}
