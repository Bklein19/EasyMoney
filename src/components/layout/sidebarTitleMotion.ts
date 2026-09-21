/** The title follows the first header-height of sidebar scrolling, then stays docked. */
export function sidebarTitleMotion(scrollTop: number) {
  const progress = Math.min(1, Math.max(0, scrollTop / 52));
  return {
    x: 52 + 34 * progress,
    y: 58 - 45 * progress,
    scale: (15 - 2 * progress) / 13,
    docked: progress === 1,
  };
}
