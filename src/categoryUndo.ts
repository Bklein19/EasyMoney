type UndoAction = {
  id: number;
  pending: boolean;
  restore: () => Promise<void>;
};

const controllers = new WeakMap<Window, ReturnType<typeof createController>>();

function createController(target: Window) {
  const actions = new Map<symbol, UndoAction>();
  let running = false;
  const undo = (event: Event) => {
    if (event.defaultPrevented) return;
    // A focused editor owns its native undo history, even when category Undo is available.
    if (
      target.document.activeElement?.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      )
    )
      return;
    const latest = [...actions.values()].sort((a, b) => b.id - a.id)[0];
    if (!latest) return;
    event.preventDefault();
    if (latest.pending || running) return;
    running = true;
    void latest.restore().finally(() => {
      running = false;
    });
  };
  const keydown = (event: KeyboardEvent) => {
    if (
      event.isComposing ||
      event.repeat ||
      event.shiftKey ||
      event.altKey ||
      !(event.metaKey || event.ctrlKey) ||
      event.key.toLowerCase() !== 'z'
    )
      return;
    // The desktop Edit menu owns Command-Z and sends easymoney:undo instead.
    if (event.metaKey && typeof target.__electrobunWebviewId === 'number') return;
    undo(event);
  };
  return {
    add(action: UndoAction) {
      const token = Symbol();
      if (!actions.size) {
        target.addEventListener('keydown', keydown);
        target.addEventListener('easymoney:undo', undo);
      }
      actions.set(token, action);
      return () => {
        actions.delete(token);
        if (!actions.size) {
          target.removeEventListener('keydown', keydown);
          target.removeEventListener('easymoney:undo', undo);
        }
      };
    },
  };
}

export function registerCategoryUndo(target: Window, action: UndoAction) {
  let controller = controllers.get(target);
  if (!controller) {
    controller = createController(target);
    controllers.set(target, controller);
  }
  return controller.add(action);
}

export function nativeUndo(target: Window) {
  const event = new Event('easymoney:undo', { cancelable: true });
  if (target.dispatchEvent(event)) target.document.execCommand('undo');
}
