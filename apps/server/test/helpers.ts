import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken, jobTypeContract, type TokenRole } from '@fornax/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach } from 'vitest';
import type { Config } from '../src/config.js';
import { type Db, openDb } from '../src/db/client.js';
import { tokens } from '../src/db/schema.js';
import { announceTypes } from '../src/domain/job-types.js';
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
export function useTestDb(overrides: Partial<Config> = {}) {
  let state: { db: Db; close: () => void; dir: string; config: Config } | undefined;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'fornax-test-'));
    const config = testConfig(dir, overrides);
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
export function useTestApp(overrides: Partial<Config> = {}) {
  const t = useTestDb(overrides);
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

export async function uploadFile(app: FastifyInstance, token: string, name: string, body: string | Buffer): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: `/api/files?name=${encodeURIComponent(name)}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, payload: body,
  });
  if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
  return res.json().id as string;
}

export function announce(db: Db, contracts: unknown[], now: Date): void {
  announceTypes(db, contracts.map((c) => jobTypeContract.parse(c)), now);
}

export const tokenIdOf = (db: Db, name: string): string => db.select({ id: tokens.id }).from(tokens).where(eq(tokens.name, name)).get()!.id;
