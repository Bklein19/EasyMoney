import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export function syncApplicationDataRoot(
  options: { home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): string {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathApi = platform === 'win32' ? win32 : posix;

  if (platform === 'darwin') {
    return pathApi.join(home, 'Library', 'Application Support', 'EasyMoney', 'sync-runs');
  }
  if (platform === 'win32') {
    return pathApi.join(env.LOCALAPPDATA ?? pathApi.join(home, 'AppData', 'Local'), 'EasyMoney', 'sync-runs');
  }
  return pathApi.join(env.XDG_STATE_HOME ?? pathApi.join(home, '.local', 'state'), 'easymoney', 'sync-runs');
}
