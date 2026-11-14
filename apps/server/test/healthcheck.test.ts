import { createServer } from 'node:net';
import { expect, test } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { healthy } from '../src/healthcheck.js';
import { useTestDb } from './helpers.js';

const t = useTestDb();

test('healthy() is true for a running server and false for a closed port', async () => {
  const app = await buildApp({ config: t.config, db: t.db, logStream: { write: () => undefined } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const { port } = app.server.address() as { port: number };
    expect(await healthy(port)).toBe(true);
  } finally {
    await app.close();
  }
  // A port that was free a moment ago: nothing listens there now.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port: free } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  expect(await healthy(free, 1000)).toBe(false);
});
