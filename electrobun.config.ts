import type { ElectrobunConfig } from 'electrobun';
import { desktopBunVersion } from './scripts/runtimeVersions.ts';

export default {
  app: {
    name: 'EasyMoney',
    identifier: 'com.easymoney.app',
    version: '0.1.0',
    description: 'Local-first personal finance',
  },
  build: {
    bunVersion: desktopBunVersion,
    bun: {
      entrypoint: 'desktop/index.ts',
    },
    views: {
      mainview: {
        entrypoint: 'src/main.tsx',
        reactCompiler: true,
      },
    },
    copy: {
      'desktop/index.html': 'views/mainview/index.html',
      'desktop-dist/sync.js': 'bun/sync.js',
      'public/favicon.svg': 'views/mainview/favicon.svg',
    },
    watch: ['server', 'scripts/sync.ts', 'scripts/build-desktop-sync.ts', 'scripts/inject-desktop-icon.ts'],
    mac: {
      bundleCEF: false,
      createDmg: false,
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
    preBuild: 'scripts/build-desktop-sync.ts',
    postBuild: 'scripts/inject-desktop-icon.ts',
    postWrap: 'scripts/inject-desktop-icon.ts',
  },
} satisfies ElectrobunConfig;
