import type { ElectrobunConfig } from 'electrobun';

export default {
  app: {
    name: 'EasyMoney',
    identifier: 'com.easymoney.app',
    version: '0.1.0',
    description: 'Local-first personal finance',
  },
  build: {
    bun: {
      entrypoint: 'desktop/index.ts',
    },
    views: {
      mainview: {
        entrypoint: 'src/main.tsx',
      },
    },
    copy: {
      'desktop/index.html': 'views/mainview/index.html',
      'desktop-dist': 'bun',
      'public/favicon.svg': 'views/mainview/favicon.svg',
    },
    watch: ['server', 'scripts/sync.ts', 'scripts/build-desktop-sync.ts'],
    mac: {
      bundleCEF: false,
      createDmg: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
  scripts: {
    preBuild: 'scripts/build-desktop-sync.ts',
  },
} satisfies ElectrobunConfig;
