import { expect, test } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { useTestDb } from './helpers.js';

const t = useTestDb();

async function seen(trustProxy: number) {
  const app = await buildApp({ config: { ...t.config, trustProxy }, db: t.db, logStream: { write: () => undefined } });
  // A probe route, added before the app is ready.
  app.get('/probe', async (req) => ({ ip: req.ip, protocol: req.protocol }));
  try {
    const res = await app.inject({ method: 'GET', url: '/probe', headers: { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' } });
    return res.json() as { ip: string; protocol: string };
  } finally {
    await app.close();
  }
}

test('TRUST_PROXY=1 takes the client address and scheme from the one proxy in front', async () => {
  expect(await seen(1)).toEqual({ ip: '203.0.113.7', protocol: 'https' });
});

test('TRUST_PROXY=0 ignores forwarded headers', async () => {
  expect(await seen(0)).toEqual({ ip: '127.0.0.1', protocol: 'http' });
});
