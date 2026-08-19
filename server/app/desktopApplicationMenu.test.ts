import { describe, expect, test } from 'bun:test';

import { macApplicationMenu } from '../../desktop/applicationMenu.ts';

function submenuNamed(label: string) {
  const menu = macApplicationMenu.find(item => 'label' in item && item.label === label);
  if (!menu || !('submenu' in menu) || !menu.submenu) throw new Error(`Missing ${label} menu`);
  return menu.submenu;
}

describe('desktop application menu', () => {
  test('provides the standard macOS quit command', () => {
    expect(submenuNamed('EasyMoney')).toContainEqual(expect.objectContaining({
      role: 'quit',
      label: 'Quit EasyMoney',
      accelerator: 'CommandOrControl+Q',
    }));
  });

  test('provides standard edit and window commands', () => {
    expect(submenuNamed('Edit')).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'undo', accelerator: 'CommandOrControl+Z' }),
      expect.objectContaining({ role: 'cut', accelerator: 'CommandOrControl+X' }),
      expect.objectContaining({ role: 'copy', accelerator: 'CommandOrControl+C' }),
      expect.objectContaining({ role: 'paste', accelerator: 'CommandOrControl+V' }),
      expect.objectContaining({ role: 'selectAll', accelerator: 'CommandOrControl+A' }),
    ]));
    expect(submenuNamed('Window')).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'minimize', accelerator: 'CommandOrControl+M' }),
      expect.objectContaining({ role: 'zoom' }),
    ]));
  });
});
