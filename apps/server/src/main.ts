import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { runMaintenance } from './domain/maintenance.js';
import { FileStore } from './files/store.js';
import { buildApp } from './http/app.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const { db, close } = openDb(config.dbFile);
const store = new FileStore(config.filesDir);
const app = await buildApp({ config, db, store });

const tick = async () => {
  try {
    const r = await runMaintenance({ config, db, store, clock: () => new Date() });
    if (Object.values(r).some((n) => n > 0)) app.log.info(r, 'maintenance');
  } catch (e) {
    app.log.error({ err: { message: (e as Error).message, stack: (e as Error).stack } }, 'maintenance failed');
  }
};
const timer = setInterval(tick, 60_000);
void tick();

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
