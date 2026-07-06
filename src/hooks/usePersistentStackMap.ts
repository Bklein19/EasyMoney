import { useCallback, useState } from 'react';

type StackMap = Record<string, string>;
type StackMapUpdater = StackMap | ((previous: StackMap) => StackMap);

function readStackMap(storageKey: string): StackMap {
  try {
    return JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') || {};
  } catch {
    return {};
  }
}

function writeStackMap(storageKey: string, value: StackMap) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

export function usePersistentStackMap(storageKey: string) {
  const [stackMap, setStackMapState] = useState(() => readStackMap(storageKey));
  const labelStorageKey = `${storageKey}:labels`;
  const [labelMap, setLabelMapState] = useState(() => readStackMap(labelStorageKey));

  const setStackMap = useCallback((updater: StackMapUpdater) => {
    setStackMapState(previous => {
      const next = typeof updater === 'function' ? updater(previous) : updater;
      writeStackMap(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const setLabelMap = useCallback((updater: StackMapUpdater) => {
    setLabelMapState(previous => {
      const next = typeof updater === 'function' ? updater(previous) : updater;
      writeStackMap(labelStorageKey, next);
      return next;
    });
  }, [labelStorageKey]);

  const stackGroup = useCallback((sourceKey: string, targetKey: string) => {
    if (!sourceKey || !targetKey || sourceKey === targetKey) return;
    setStackMap(previous => ({
      ...previous,
      [sourceKey]: targetKey
    }));
  }, [setStackMap]);

  const undoStack = useCallback((targetKey: string) => {
    setStackMap(previous => {
      const next: StackMap = {};
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

  const renameStack = useCallback((targetKey: string, label: string) => {
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
