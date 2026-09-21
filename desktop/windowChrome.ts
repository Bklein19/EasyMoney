/** Native controls own non-macOS chrome; only macOS uses our inset title strip. */
export function windowChrome(platform: NodeJS.Platform) {
  const macOS = platform === 'darwin';
  const platformClass = macOS ? 'easymoney-macos' : platform === 'win32' ? 'easymoney-windows' : 'easymoney-linux';
  return {
    titleBarStyle: macOS ? 'hiddenInset' as const : 'default' as const,
    // The main process is authoritative. Avoid navigator/UA platform guessing,
    // and run for each new document, including reloads and deep links.
    preload: `(() => {
      const applyPlatform = () => document.documentElement.classList.add(${JSON.stringify(platformClass)});
      if (document.documentElement) applyPlatform();
      else document.addEventListener('DOMContentLoaded', applyPlatform, { once: true });
    })();`,
  };
}
