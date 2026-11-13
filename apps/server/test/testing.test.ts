import { expect, test } from 'vitest';
import { startTestServer } from '../src/testing.js';

test('startTestServer: a real server on a free port with working tokens', async () => {
  const s = await startTestServer();
  try {
    expect(await (await fetch(`${s.url}/healthz`)).json()).toEqual({ ok: true });
    const worker = s.issueToken('pc', 'worker');
    expect((await fetch(`${s.url}/api/worker/ping`, { headers: { authorization: `Bearer ${worker}` } })).status).toBe(200);
    expect(s.config.publicUrl).toBe(s.url);
  } finally {
    await s.close();
  }
});
