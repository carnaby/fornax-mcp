import { expect, test, vi } from 'vitest';
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

test('startTestServer keeps its log lines; only errors reach stdout', async () => {
  const s = await startTestServer();
  const printed: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => printed.push(String(chunk)) > 0);
  try {
    s.app.log.warn('an expected warning');
    s.app.log.error('a real error');
  } finally {
    out.mockRestore();
    await s.close();
  }
  expect(s.logs.join('')).toContain('an expected warning');
  expect(s.logs.join('')).toContain('a real error');
  expect(printed.join('')).toContain('a real error');
  expect(printed.join('')).not.toContain('an expected warning');
});
