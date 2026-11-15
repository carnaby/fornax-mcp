import type { OperatorQueue } from '@fornax/protocol';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { Ctx } from '../src/commands/context.js';
import { duration, renderQueue } from '../src/commands/queue.js';
import { saveServer, saveToken } from '../src/config.js';
import { loadPack } from '../src/pack.js';
import { clientOf, testPaths, useTempDir, writeEchoPack } from './helpers.js';

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
  if (opts.paired !== false) {
    saveServer(paths, s.url);
    saveToken(paths, s.issueToken('pc', 'worker'));
  }
  const out: string[] = [];
  const err: string[] = [];
  const ctx: Ctx = { paths, out: (l) => out.push(l), err: (l) => err.push(l), env: {}, signal: new AbortController().signal };
  return { s, ctx, out, err, client: clientOf(s, s.issueToken('alice')) };
}

const view = (over: Partial<OperatorQueue> = {}): OperatorQueue => ({
  server_time: '2026-11-15T14:00:00.000Z', change: '0123456789abcdef', paused: false,
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
