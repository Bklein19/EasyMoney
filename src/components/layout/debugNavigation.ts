export function debugShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing'>): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.repeat && !event.isComposing && event.key.toLowerCase() === 'd';
}

export function visibleNavigationPath(path: string, debug: boolean): boolean {
  return debug || !path.startsWith('/debug/');
}
