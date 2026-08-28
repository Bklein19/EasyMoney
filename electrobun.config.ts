import type { ElectrobunConfig } from 'electrobun';

export default {
  app: {
    name: 'EasyMoney',
    identifier: 'com.easymoney.app',
    version: '0.1.0',
    description: 'Local-first personal finance',
  },
  build: {
    mainProcess: 'bun',
    bun: {
      entrypoint: 'desktop/index.ts',
    },
    copy: {
      dist: 'views/mainview',
      'desktop-dist/sync.js': 'bun/sync.js',
    },
    watch: [
      'desktop',
      'index.html',
      'public',
      'server',
      'src',
      'scripts/sync.ts',
      'scripts/build-client.ts',
      'scripts/build-desktop-assets.ts',
      'scripts/build-desktop-sync.ts',
    ],
    watchIgnore: ['dist/**', 'desktop-dist/**', 'data/**', '.env.local', '.git/**'],
    mac: {
      bundleCEF: false,
      createDmg: false,
      icons: 'assets/icon.iconset',
    },
    linux: {
      bundleCEF: false,
      icon: 'assets/app-icon.png',
    },
    win: {
      bundleCEF: false,
      icon: 'assets/app-icon.png',
    },
  },
  scripts: {
    preBuild: 'scripts/build-desktop-assets.ts',
  },
} satisfies ElectrobunConfig;
