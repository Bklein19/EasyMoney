import { useCallback, useState } from 'react';

function readStackMap(storageKey) {
  try {
    return JSON.parse(window.localStorage.getItem(storageKey)) || {};
  } catch {
    return {};
  }
}

function writeStackMap(storageKey, value) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

export function usePersistentStackMap(storageKey) {
  const [stackMap, setStackMapState] = useState(() => readStackMap(storageKey));

  const setStackMap = useCallback((updater) => {
    setStackMapState(previous => {
      const next = typeof updater === 'function' ? updater(previous) : updater;
      writeStackMap(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const stackGroup = useCallback((sourceKey, targetKey) => {
    if (!sourceKey || !targetKey || sourceKey === targetKey) return;
    setStackMap(previous => ({
      ...previous,
      [sourceKey]: targetKey
    }));
  }, [setStackMap]);

  const undoStack = useCallback((targetKey) => {
    setStackMap(previous => {
      const next = {};
      Object.entries(previous).forEach(([sourceKey, stackedTargetKey]) => {
        if (stackedTargetKey !== targetKey) {
          next[sourceKey] = stackedTargetKey;
        }
      });
      return next;
    });
  }, [setStackMap]);

  return { stackMap, stackGroup, undoStack };
}
