import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { runMaintenance } from './domain/maintenance.js';
import { startWebhookLoop } from './domain/webhooks.js';
import { FileStore } from './files/store.js';
import { buildApp } from './http/app.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const { db, close } = openDb(config.dbFile);
const store = new FileStore(config.filesDir);
let maintenanceAt = new Date();
const app = await buildApp({ config, db, store, maintenanceAt: () => maintenanceAt });
if (!config.publicUrlConfigured) {
  app.log.warn({ publicUrl: config.publicUrl }, 'PUBLIC_URL is not set: invite and upload links will point to localhost');
}

let inFlight = false;
const tick = async () => {
  if (inFlight) return;
  inFlight = true;
  try {
    const r = await runMaintenance({ config, db, store, clock: () => new Date() });
    if (Object.values(r).some((n) => n > 0)) app.log.info(r, 'maintenance');
  } catch (e) {
    app.log.error({ err: { message: (e as Error).message, stack: (e as Error).stack } }, 'maintenance failed');
  } finally {
    inFlight = false;
    maintenanceAt = new Date();
  }
};
const timer = setInterval(tick, 60_000);
const webhooks = startWebhookLoop({ config, db, clock: () => new Date() }, app.log);
void tick();

// app.close() waits for requests in flight; a large upload would hold SIGTERM until the runtime sends SIGKILL.
const SHUTDOWN_LIMIT_MS = 8_000;

const closeDb = () => {
  try {
    close();
  } catch (e) {
    app.log.error({ err: { message: (e as Error).message, stack: (e as Error).stack } }, 'closing the database failed');
  }
};

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  setTimeout(() => {
    app.log.warn({ limitMs: SHUTDOWN_LIMIT_MS }, 'shutdown took too long: requests still in flight were cut off');
    closeDb();
    process.exit(0);
  }, SHUTDOWN_LIMIT_MS).unref();
  clearInterval(timer);
  await webhooks.stop();
  try {
    await app.close();
  } catch (e) {
    app.log.error({ err: { message: (e as Error).message, stack: (e as Error).stack } }, 'closing the HTTP server failed');
  }
  closeDb();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
