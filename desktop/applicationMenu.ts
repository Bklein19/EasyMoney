import type { ApplicationMenuItemConfig } from 'electrobun/main';

export const macApplicationMenu: ApplicationMenuItemConfig[] = [
  {
    label: 'Easymoney',
    submenu: [
      { role: 'about', label: 'About Easymoney' },
      { type: 'divider' },
      { role: 'hide', accelerator: 'CommandOrControl+H' },
      { role: 'hideOthers', accelerator: 'CommandOrControl+Alt+H' },
      { role: 'showAll' },
      { type: 'divider' },
      { role: 'quit', label: 'Quit Easymoney', accelerator: 'CommandOrControl+Q' },
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
    label: 'Go',
    submenu: [
      { label: 'Back', action: 'navigate-back', accelerator: 'CommandOrControl+[' },
      { label: 'Forward', action: 'navigate-forward', accelerator: 'CommandOrControl+]' },
      { type: 'divider' },
      { label: 'Show/Hide Debug Pages', action: 'toggle-debug', accelerator: 'CommandOrControl+D' },
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
