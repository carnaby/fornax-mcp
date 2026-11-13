import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken, type TokenRole } from '@fornax/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach } from 'vitest';
import type { Config } from '../src/config.js';
import { type Db, openDb } from '../src/db/client.js';
import { approveToken, createInvite, resolveToken } from '../src/domain/tokens.js';
import { buildApp } from '../src/http/app.js';

export const TEST_SECRET = 's'.repeat(32);

export function testConfig(dataDir: string, overrides: Partial<Config> = {}): Config {
  return {
    dataDir,
    dbFile: join(dataDir, 'fornax.db'),
    filesDir: join(dataDir, 'files'),
    publicUrl: 'https://fornax.example.com',
    secret: TEST_SECRET,
    port: 0,
    host: '127.0.0.1',
    limits: { maxUploadBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024, maxQueuedPerToken: 50 },
    retention: { finishedMs: 14 * 86_400_000, orphanUploadMs: 24 * 3_600_000, unavailableTypeMs: 7 * 86_400_000, pendingTokenMs: 7 * 86_400_000 },
    webhooks: { allowedPrefixes: [] },
    ...overrides,
  };
}

/** A fresh database in a fresh temp directory for every test; closed (Windows locks open files) and removed after. */
export function useTestDb() {
  let state: { db: Db; close: () => void; dir: string; config: Config } | undefined;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'fornax-test-'));
    const config = testConfig(dir);
    const { db, close } = openDb(config.dbFile);
    state = { db, close, dir, config };
  });
  afterEach(() => {
    state?.close();
    if (state) rmSync(state.dir, { recursive: true, force: true });
    state = undefined;
  });
  return {
    get db() {
      return state!.db;
    },
    get dir() {
      return state!.dir;
    },
    get config() {
      return state!.config;
    },
  };
}

/** An active token, through the real invite → first use → approve path. */
export function issueToken(db: Db, name: string, role: TokenRole = 'client', now = new Date()): string {
  createInvite(db, { name, role }, now);
  const raw = generateToken(name);
  resolveToken(db, raw, now);
  approveToken(db, name, now);
  return raw;
}

/** A test database plus an app over it, with a clock the test moves by hand. */
export function useTestApp() {
  const t = useTestDb();
  const clock = {
    now: new Date('2026-11-13T10:00:00Z'),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  let app: FastifyInstance | undefined;
  beforeEach(async () => {
    clock.now = new Date('2026-11-13T10:00:00Z');
    app = await buildApp({ config: t.config, db: t.db, clock: () => clock.now });
  });
  afterEach(async () => {
    await app?.close();
  });
  return {
    clock,
    get app() {
      return app!;
    },
    get db() {
      return t.db;
    },
    get config() {
      return t.config;
    },
    get dir() {
      return t.dir;
    },
  };
}
