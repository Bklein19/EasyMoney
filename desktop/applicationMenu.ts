import type { ApplicationMenuItemConfig } from 'electrobun/bun';

export const macApplicationMenu: ApplicationMenuItemConfig[] = [
  {
    label: 'EasyMoney',
    submenu: [
      { role: 'about', label: 'About EasyMoney' },
      { type: 'divider' },
      { role: 'hide', accelerator: 'CommandOrControl+H' },
      { role: 'hideOthers', accelerator: 'CommandOrControl+Alt+H' },
      { role: 'showAll' },
      { type: 'divider' },
      { role: 'quit', label: 'Quit EasyMoney', accelerator: 'CommandOrControl+Q' },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo', accelerator: 'CommandOrControl+Z' },
      { role: 'redo', accelerator: 'CommandOrControl+Shift+Z' },
      { type: 'divider' },
      { role: 'cut', accelerator: 'CommandOrControl+X' },
      { role: 'copy', accelerator: 'CommandOrControl+C' },
      { role: 'paste', accelerator: 'CommandOrControl+V' },
      { role: 'pasteAndMatchStyle', accelerator: 'CommandOrControl+Alt+Shift+V' },
      { role: 'delete' },
      { role: 'selectAll', accelerator: 'CommandOrControl+A' },
    ],
  },
  {
    label: 'Window',
    submenu: [
      { role: 'minimize', accelerator: 'CommandOrControl+M' },
      { role: 'zoom' },
      { type: 'divider' },
      { role: 'bringAllToFront' },
    ],
  },
];
