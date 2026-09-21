type NavigationKey = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

export function navigationDelta(key: NavigationKey): -1 | 1 | null {
  if (key.shiftKey || key.ctrlKey) return null;
  if (key.key === 'BrowserBack') return -1;
  if (key.key === 'BrowserForward') return 1;
  if (key.metaKey && !key.altKey) {
    if (key.key === '[') return -1;
    if (key.key === ']') return 1;
  }
  if (key.altKey && !key.metaKey) {
    if (key.key === 'ArrowLeft') return -1;
    if (key.key === 'ArrowRight') return 1;
  }
  return null;
}

export function installNavigationActions(target: Window, navigate: (delta: number) => void) {
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    // Option-arrow is a text-editing command on macOS. Preserve it in fields.
    const element = event.target;
    if (event.altKey && element instanceof HTMLElement && element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const delta = navigationDelta(event);
    if (delta === null) return;
    // Desktop Command-brackets are owned by the native Go menu.
    if (event.metaKey && typeof target.__electrobunWebviewId === 'number') return;
    event.preventDefault();
    navigate(delta);
  };
  const nativeNavigation = (event: Event) => {
    const delta: unknown = (event as CustomEvent).detail;
    if (delta === -1 || delta === 1) navigate(delta);
  };
  const mouseup = (event: MouseEvent) => {
    if (event.defaultPrevented || (event.button !== 3 && event.button !== 4)) return;
    event.preventDefault();
    navigate(event.button === 3 ? -1 : 1);
  };
  // Consume the follow-up auxiliary click to avoid a second native traversal.
  const auxclick = (event: MouseEvent) => {
    if (event.button === 3 || event.button === 4) event.preventDefault();
  };
  target.addEventListener('keydown', keydown);
  target.addEventListener('easymoney:navigate-history', nativeNavigation);
  target.addEventListener('mouseup', mouseup);
  target.addEventListener('auxclick', auxclick);
  return () => {
    target.removeEventListener('keydown', keydown);
    target.removeEventListener('easymoney:navigate-history', nativeNavigation);
    target.removeEventListener('mouseup', mouseup);
    target.removeEventListener('auxclick', auxclick);
  };
}
