import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OperatorQueue } from '@fornax/protocol';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import { WorkerApi } from '../src/api.js';
import { runCli } from '../src/cli.js';
import type { Ctx } from '../src/commands/context.js';
import { duration, queueWatch, renderQueue } from '../src/commands/queue.js';
import { saveServer, saveToken } from '../src/config.js';
import { loadPack } from '../src/pack.js';
import { clientOf, testPaths, useTempDir, waitFor, writeEchoPack } from './helpers.js';

const tmp = useTempDir();
const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** A test server with the echo type offered, a worker token on this "PC" and a client that submits jobs. */
async function setup(opts: { paired?: boolean } = {}) {
  const s = await startTestServer();
  servers.push(s);
  const root = tmp();
  const paths = testPaths(root);
  s.announce([loadPack(writeEchoPack(paths.typesDir)).contract]);
  // The raw worker token: a test that starts the server again gives it back to the new one.
  const workerToken = opts.paired !== false ? s.issueToken('pc', 'worker') : '';
  if (opts.paired !== false) {
    saveServer(paths, s.url);
    saveToken(paths, workerToken);
  }
  const out: string[] = [];
  const err: string[] = [];
  const ctx: Ctx = { paths, out: (l) => out.push(l), err: (l) => err.push(l), env: {}, signal: new AbortController().signal };
  return { s, ctx, out, err, workerToken, client: clientOf(s, s.issueToken('alice')) };
}

const view = (over: Partial<OperatorQueue> = {}): OperatorQueue => ({
  server_time: '2026-11-15T14:00:00.000Z', server_version: '0.5.0', change: '0123456789abcdef', paused: false, paused_at: null,
  worker: { online: true, last_seen: '2026-11-15T13:59:58.000Z', version: '0.5.0', waiting: null },
  running: null, queued: [], finished: [], ...over,
});
const job = (over: Partial<OperatorQueue['queued'][number]> = {}): OperatorQueue['queued'][number] => ({
  id: '01JTEST', type: 'upscale', owner: 'carol', state: 'queued', label: null, group: null, priority: 'normal',
  inputs: { video: 'clip.mp4' }, attempts: 0, type_unavailable: false, run_after: null,
  created_at: '2026-11-15T13:56:00.000Z', started_at: null, finished_at: null,
  progress: null, progress_message: null, error: null, result_url: 'https://fornax.example.com/r/x', ...over,
});

describe('renderQueue', () => {
  test('headline, running with elapsed time and progress, waiting in order with notes, finished with errors', () => {
    const lines = renderQueue(view({
      running: job({ id: 'R1', state: 'running', started_at: '2026-11-15T13:47:13.000Z', progress: 0.62, progress_message: 'encoding batch 2/4' }),
      queued: [job({ id: 'Q1', type: 'render', inputs: { scene: 'scene.blend' } }), job({ id: 'Q2', type: 'lease', owner: 'bob', label: 'chrome', inputs: {}, type_unavailable: true, run_after: '2026-11-15T14:05:00.000Z' })],
      finished: [job({ id: 'F1', state: 'failed', error: 'bad input', started_at: '2026-11-15T13:40:00.000Z', finished_at: '2026-11-15T13:40:12.000Z' })],
    }));
    expect(lines[0]).toBe('queue active · worker online (0.5.0)');
    expect(lines[1]).toContain('running');
    expect(lines[1]).toContain('upscale  carol  clip.mp4  12:47  62 %  encoding batch 2/4  R1');
    expect(lines[2]).toContain('1  render  carol  scene.blend  waits 4:00  Q1');
    expect(lines[3]).toContain('2  lease  bob  chrome  waits 4:00  type not offered, retry at ');
    expect(lines[4]).toContain('failed  upscale  carol  clip.mp4  took 0:12  at ');
    expect(lines[5]).toBe('          bad input');
  });

  test('paused, pausing, offline, never connected, an empty queue', () => {
    expect(renderQueue(view({ paused: true }))[0]).toBe('queue paused · worker online (0.5.0)');
    expect(renderQueue(view({ paused: true, running: job({ state: 'running', started_at: '2026-11-15T13:59:00.000Z' }) }))[0]).toBe(
      'queue pausing after the running job · worker online (0.5.0)',
    );
    expect(renderQueue(view({ worker: { online: false, last_seen: null, version: null, waiting: null } }))[0]).toBe('queue active · worker never connected');
    expect(renderQueue(view({ worker: { online: false, last_seen: '2026-11-15T13:00:00.000Z', version: null, waiting: null } }))[0]).toMatch(/^queue active · worker offline since \d\d:\d\d$/);
    expect(renderQueue(view()).slice(1)).toEqual(['running   nothing', 'waiting   nothing']);
  });

  test('durations', () => {
    expect(duration(0)).toBe('0:00');
    expect(duration(61_000)).toBe('1:01');
    expect(duration(3_725_000)).toBe('1:02:05');
    expect(duration(-5)).toBe('0:00');
  });
});

describe('fornax queue (spec 06 3.1)', () => {
  test('shows the queue; --json prints one line with ok', async () => {
    const { ctx, out, client } = await setup();
    const a = await client.submit('echo', { mode: 'ok' });
    expect(await runCli(['queue'], ctx)).toBe(0);
    expect(out[0]).toBe('queue active · worker never connected');
    expect(out.join('\n')).toContain(a.id);
    out.splice(0);
    expect(await runCli(['queue', '--json'], ctx)).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, queued: [{ id: a.id, owner: 'alice' }] });
  });

  test('move, cancel, pause and resume say what they did', async () => {
    const { ctx, out, client } = await setup();
    const a = await client.submit('echo', { mode: 'ok' });
    const b = await client.submit('echo', { mode: 'ok' });
    expect(await runCli(['queue', 'move', b.id, '--top'], ctx)).toBe(0);
    expect(await runCli(['queue', 'move', b.id, '--after', a.id], ctx)).toBe(0);
    expect(await runCli(['queue', 'cancel', a.id], ctx)).toBe(0);
    expect(await runCli(['queue', 'pause'], ctx)).toBe(0);
    expect(await runCli(['queue', 'resume'], ctx)).toBe(0);
    expect(out).toEqual([
      `moved job ${b.id} to the top`,
      `moved job ${b.id} after ${a.id}`,
      `canceled job ${a.id}`,
      'the queue is paused: no job starts',
      'the queue runs again',
    ]);
  });

  test('pause and resume --json print the queue the server answered with (the tray reads its time)', async () => {
    const { ctx, out } = await setup();
    expect(await runCli(['queue', 'pause', '--json'], ctx)).toBe(0);
    expect(await runCli(['queue', 'resume', '--json'], ctx)).toBe(0);
    expect(out).toHaveLength(2);
    const [paused, resumed] = out.map((l) => JSON.parse(l));
    expect(paused).toMatchObject({ ok: true, paused: true, paused_at: expect.any(String), server_time: expect.any(String) });
    expect(resumed).toMatchObject({ ok: true, paused: false, paused_at: null });
  });

  test('an error of the server is the last line on stderr, exit 1', async () => {
    const { ctx, err, client } = await setup();
    const a = await client.submit('echo', { mode: 'ok' });
    await client.cancel(a.id);
    expect(await runCli(['queue', 'move', a.id, '--top'], ctx)).toBe(1);
    expect(err.at(-1)).toBe(`job ${a.id} is canceled; only waiting jobs move`);
  });

  test('without a worker token: not paired, exit 1', async () => {
    const { ctx, err } = await setup({ paired: false });
    expect(await runCli(['queue'], ctx)).toBe(1);
    expect(err.at(-1)).toBe('this computer is not paired as a worker (fornax worker pair)');
  });

  test('usage errors are exit 2: no target, two targets, a stray flag', async () => {
    const { ctx } = await setup();
    expect(await runCli(['queue', 'move', 'X'], ctx)).toBe(2);
    expect(await runCli(['queue', 'move', 'X', '--top', '--bottom'], ctx)).toBe(2);
    expect(await runCli(['queue', 'cancel', 'X', '--json'], ctx)).toBe(2);
    expect(await runCli(['queue', 'pause', '--top'], ctx)).toBe(2);
  });
});

describe('fornax queue --watch (spec 06 3.1)', () => {
  test('prints the queue, then each change; ends with the stop signal', async () => {
    const { ctx, out, client } = await setup();
    const stop = new AbortController();
    const watching = queueWatch({ ...ctx, signal: stop.signal }, { json: true, waitS: 5 });
    await waitForLines(out, 1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, queued: [] });
    const a = await client.submit('echo', { mode: 'ok' });
    await waitForLines(out, 2);
    expect(JSON.parse(out[1]!)).toMatchObject({ ok: true, queued: [{ id: a.id }] });
    stop.abort();
    expect(await watching).toBe(0);
  });

  test('an unreachable server: an error line, then the queue once it answers again', async () => {
    const { s, ctx, out, workerToken } = await setup();
    const port = Number(new URL(s.url).port);
    await s.close();
    servers.splice(0);
    const stop = new AbortController();
    // authRetryMs: should a read reach the new server before it knows the token, the watch asks again soon.
    const watching = queueWatch({ ...ctx, signal: stop.signal }, { json: true, waitS: 1, retryMs: [50], authRetryMs: 50 });
    await waitForLines(out, 1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, error: 'network' });
    // The same server again: a fresh database, given the worker token this PC holds.
    const again = await startTestServer({ port });
    servers.push(again);
    again.issueToken('pc', 'worker', workerToken);
    await waitFor(() => out.some((l) => JSON.parse(l).ok === true), 10_000, 'the queue after the failure');
    const ok = out.findIndex((l) => JSON.parse(l).ok === true);
    expect(ok).toBeGreaterThan(0);
    expect(JSON.parse(out[ok]!)).toMatchObject({ ok: true, paused: false, running: null, queued: [] });
    stop.abort();
    expect(await watching).toBe(0);
  });

  test('a server that does not know the token: an auth line, asked again later', async () => {
    const { ctx, out } = await setup();
    const other = await startTestServer();
    servers.push(other);
    saveServer(ctx.paths, other.url);
    const stop = new AbortController();
    const watching = queueWatch({ ...ctx, signal: stop.signal }, { json: true, waitS: 1, retryMs: [50], authRetryMs: 50 });
    await waitForLines(out, 2);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, error: 'auth' });
    expect(JSON.parse(out[1]!)).toMatchObject({ ok: false, error: 'auth' });
    stop.abort();
    expect(await watching).toBe(0);
  });

  test('a server that never answers counts as unreachable and is asked again', async () => {
    const { ctx, out } = await setup();
    const hanging = createServer(() => {});
    await new Promise<void>((r) => hanging.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`;
      const stop = new AbortController();
      const watching = queueWatch({ ...ctx, signal: stop.signal, makeApi: (_s, token) => new WorkerApi({ server: url, token }) }, { json: true, waitS: 0, retryMs: [50], requestTimeoutMs: 300 });
      await waitForLines(out, 1, 5000);
      expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, error: 'network', message: 'the server did not answer in time' });
      stop.abort();
      expect(await watching).toBe(0);
    } finally {
      hanging.closeAllConnections();
      hanging.close();
    }
  });

  test('an answer that breaks off mid-body counts as unreachable and is asked again', async () => {
    const { ctx, out } = await setup();
    const breaking = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"ok":');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((r) => breaking.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(breaking.address() as AddressInfo).port}`;
      const stop = new AbortController();
      const watching = queueWatch({ ...ctx, signal: stop.signal, makeApi: (_s, token) => new WorkerApi({ server: url, token }) }, { json: true, waitS: 0, retryMs: [50] });
      await waitForLines(out, 2, 5000);
      expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, error: 'network' });
      expect(JSON.parse(out[1]!)).toMatchObject({ ok: false, error: 'network' });
      stop.abort();
      expect(await watching).toBe(0);
    } finally {
      breaking.closeAllConnections();
      breaking.close();
    }
  });
});

async function waitForLines(lines: string[], n: number, ms = 10_000): Promise<void> {
  await waitFor(() => lines.length >= n, ms, `${n} lines`);
}
