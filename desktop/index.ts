import fs from 'node:fs';
import path from 'node:path';
import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, Utils } from 'electrobun/bun';
import {
  callTRPCProcedure,
  getTRPCErrorFromUnknown,
  getTRPCErrorShape,
} from '@trpc/server';
import { migrateLegacyData } from './dataMigration.ts';
import { macApplicationMenu } from './applicationMenu.ts';
import type { EasyMoneyDesktopRpc } from './rpc.ts';

const dataDirectory = Utils.paths.userData;
fs.mkdirSync(dataDirectory, { recursive: true });

process.env.EASYMONEY_DESKTOP = '1';
const configuredDatabasePath = process.env.EASYMONEY_DB_PATH;
const configuredEnvironmentPath = process.env.EASYMONEY_ENV_PATH;
const databasePath = configuredDatabasePath || path.join(dataDirectory, 'easymoney.sqlite');
const environmentPath = configuredEnvironmentPath || path.join(dataDirectory, '.env.local');

if (!configuredDatabasePath && !configuredEnvironmentPath) {
  const migration = migrateLegacyData({
    homeDirectory: Utils.paths.home,
    databasePath,
    environmentPath,
  });
  if (migration.migratedDatabaseFrom) {
    console.log(`Migrated the legacy EasyMoney database from ${migration.migratedDatabaseFrom}`);
  }
}

process.env.EASYMONEY_DB_PATH = databasePath;
process.env.EASYMONEY_ENV_PATH = environmentPath;

const [databaseModule, seedModule, envModule, routerModule] = await Promise.all([
  import('../server/database.ts'),
  import('../server/seed.ts'),
  import('../server/app/localEnv.ts'),
  import('../server/app/router.ts'),
]);

envModule.loadLocalEnv();
databaseModule.initDatabase();
seedModule.seedDatabase();

const { appRouter } = routerModule;

if (process.platform === 'darwin') {
  ApplicationMenu.setApplicationMenu(macApplicationMenu);
}

const rpc = BrowserView.defineRPC<EasyMoneyDesktopRpc>({
  maxRequestTime: Infinity,
  handlers: {
    requests: {
      trpc: async ({ path: procedurePath, type, input }) => {
        try {
          const data = await callTRPCProcedure({
            router: appRouter,
            path: procedurePath,
            getRawInput: async () => input,
            ctx: {},
            type,
            signal: undefined,
            batchIndex: 0,
          });
          return { ok: true, data };
        } catch (cause) {
          const error = getTRPCErrorFromUnknown(cause);
          const shape = getTRPCErrorShape({
            config: appRouter._def._config,
            ctx: {},
            error,
            input,
            path: procedurePath,
            type,
          });
          console.error(`[tRPC] ${type} ${procedurePath}:`, error);
          return { ok: false, error: shape };
        }
      },
    },
    messages: {},
  },
});

new BrowserWindow({
  title: 'EasyMoney',
  titleBarStyle: 'hiddenInset',
  trafficLightOffset: { x: 16, y: 12 },
  url: 'views://mainview/index.html',
  rpc,
  frame: {
    width: 1440,
    height: 900,
    x: 80,
    y: 80,
  },
});

Electrobun.events.on('before-quit', () => {
  databaseModule.closeDatabase();
});

console.log(`EasyMoney desktop app started with data in ${dataDirectory}`);
