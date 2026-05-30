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
  const labelStorageKey = `${storageKey}:labels`;
  const [labelMap, setLabelMapState] = useState(() => readStackMap(labelStorageKey));

  const setStackMap = useCallback((updater) => {
    setStackMapState(previous => {
      const next = typeof updater === 'function' ? updater(previous) : updater;
      writeStackMap(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const setLabelMap = useCallback((updater) => {
    setLabelMapState(previous => {
      const next = typeof updater === 'function' ? updater(previous) : updater;
      writeStackMap(labelStorageKey, next);
      return next;
    });
  }, [labelStorageKey]);

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
    setLabelMap(previous => {
      if (!previous[targetKey]) return previous;
      const next = { ...previous };
      delete next[targetKey];
      return next;
    });
  }, [setStackMap, setLabelMap]);

  const renameStack = useCallback((targetKey, label) => {
    const nextLabel = label.trim();
    setLabelMap(previous => {
      const next = { ...previous };
      if (nextLabel) next[targetKey] = nextLabel;
      else delete next[targetKey];
      return next;
    });
  }, [setLabelMap]);

  return { stackMap, labelMap, stackGroup, undoStack, renameStack };
}
