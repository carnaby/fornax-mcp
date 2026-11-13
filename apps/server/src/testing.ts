import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken, type TokenRole } from '@fornax/protocol';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { type Db, openDb } from './db/client.js';
import { approveToken, createInvite, resolveToken } from './domain/tokens.js';
import { buildApp } from './http/app.js';

/** A real server on a free local port over a fresh temp data directory: for other packages' integration tests. */
export type TestServer = {
  url: string;
  app: FastifyInstance;
  db: Db;
  config: Config;
  /** An active token, through the real invite → first use → approve path. */
  issueToken(name: string, role?: TokenRole): string;
  /** What `fornax-admin tokens invite <name> [--worker]` does. */
  invite(name: string, role: TokenRole): void;
  /** What `fornax-admin tokens approve <name>` does. */
  approve(name: string): void;
  close(): Promise<void>;
};

export async function startTestServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'fornax-server-'));
  const config: Config = {
    dataDir: dir,
    dbFile: join(dir, 'fornax.db'),
    filesDir: join(dir, 'files'),
    publicUrl: 'http://127.0.0.1',
    publicUrlConfigured: true,
    secret: 's'.repeat(32),
    port: 0,
    host: '127.0.0.1',
    limits: { maxUploadBytes: 16 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, maxQueuedPerToken: 50 },
    retention: { finishedMs: 14 * 86_400_000, orphanUploadMs: 24 * 3_600_000, unavailableTypeMs: 7 * 86_400_000, pendingTokenMs: 7 * 86_400_000 },
    webhooks: { allowedPrefixes: [] },
    ...overrides,
  };
  const { db, close } = openDb(config.dbFile);
  const app = await buildApp({ config, db });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  // The app holds this same object: links it makes point at the real port.
  config.publicUrl = url;
  return {
    url,
    app,
    db,
    config,
    issueToken(name, role = 'client') {
      createInvite(db, { name, role }, new Date());
      const raw = generateToken(name);
      resolveToken(db, raw, new Date());
      approveToken(db, name, new Date());
      return raw;
    },
    invite(name, role) {
      createInvite(db, { name, role }, new Date());
    },
    approve(name) {
      approveToken(db, name, new Date());
    },
    async close() {
      // Keep-alive sockets of the test clients must not hold the close up.
      const closing = app.close();
      app.server.closeAllConnections();
      await closing;
      close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
