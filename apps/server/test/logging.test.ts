import { afterEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { issueToken, useTestDb } from './helpers.js';

const t = useTestDb();
const SECRET = 'SECRETVALUE';

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(lines: string[]) {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  try {
    app = await buildApp({ config: t.config, db: t.db, logStream: { write: (m) => void lines.push(m) } });
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
  return app;
}

describe('log masking', () => {
  test('secrets in URLs never reach the logs', async () => {
    const lines: string[] = [];
    const a = await build(lines);
    const client = issueToken(t.db, 'alice', 'client');
    for (const [url, headers] of [
      [`/mcp/fornax-alice-${SECRET}`, {}],
      [`/api/whoami?sig=${SECRET}`, {}],
      [`/api/whoami?sig=${SECRET}`, { authorization: `Bearer ${client}` }],
      [`/api/uploads/${SECRET}.1.sig`, {}],
      [`/nope/${SECRET}`, {}],
    ] as const) {
      await a.inject({ method: 'GET', url, headers });
    }
    const out = lines.join('');
    expect(out).toContain('incoming request');
    expect(out).not.toContain(SECRET);
  });

  test('a failing handler answers 500 without details', async () => {
    const lines: string[] = [];
    const a = await build(lines);
    a.get('/boom', async () => {
      throw new Error(`db failed for ${SECRET}`);
    });
    const res = await a.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal', message: 'internal error' });
  });
});
