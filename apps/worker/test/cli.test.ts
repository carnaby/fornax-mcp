import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fingerprint } from '@fornax/protocol';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, type WorkerApi } from '../src/api.js';
import { makeSignalHandler, runCli, wireSignals } from '../src/cli.js';
import { hasRunning, killRunning, runProcess } from '../src/process.js';
import type { Ctx } from '../src/commands/context.js';
import { readToken, readWorkerConfig, saveToken } from '../src/config.js';
import { lockWorker } from '../src/instance.js';
import { testPaths, useTempDir, waitFor, writeEchoPack } from './helpers.js';

const tmp = useTempDir();
const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function server(): Promise<TestServer> {
  const s = await startTestServer();
  servers.push(s);
  return s;
}

function cli() {
  const lines: string[] = [];
  const ctx: Ctx = {
    paths: testPaths(tmp()),
    out: (l) => lines.push(l),
    signal: new AbortController().signal,
    clipboard: () => null,
    loopOptions: { claimWaitS: 0, checkTimeoutMs: 10_000 },
  };
  const run = async (...argv: string[]) => {
    lines.length = 0;
    const code = await runCli(argv, ctx);
    return { code, text: lines.join('\n') };
  };
  return { ctx, run };
}

describe('fornax CLI', () => {
  test('pair, wait for approval, doctor, then serve once', async () => {
    const s = await server();
    const { ctx, run } = cli();
    s.invite('pc', 'worker');
    const paired = await run('worker', 'pair', '--server', s.url, '--name', 'pc');
    expect(paired.code).toBe(0);
    const token = readToken(ctx.paths)!;
    expect(paired.text).toContain(`Fingerprint: ${fingerprint(token)}`);
    expect(paired.text).toContain('fornax-admin tokens approve pc');
    expect(paired.text).not.toContain(token);
    expect(readWorkerConfig(ctx.paths).server).toBe(s.url);

    const waiting = await run('doctor');
    expect(waiting.code).toBe(1);
    expect(waiting.text).toMatch(/FAIL\s+server .*waits for approval/);

    s.approve('pc');
    writeFileSync(ctx.paths.configFile, `server: ${s.url}\ntools:\n  node: ${JSON.stringify(process.execPath)}\n`);
    writeEchoPack(ctx.paths.typesDir);
    const healthy = await run('doctor');
    expect(healthy.text).toMatch(/ok\s+server .*token active/);
    expect(healthy.text).toMatch(/ok\s+tool node/);
    expect(healthy.text).toMatch(/ok\s+type echo v1/);
    expect(healthy.code).toBe(0);

    const served = await run('worker', '--once');
    expect(served.code).toBe(0);
    expect(served.text).toContain('offering: echo');
    expect(await run('worker', 'queue')).toEqual({ code: 0, text: 'queued 0, running 0' });
  });

  test('pairing needs an open invite and does not replace a token without --force', async () => {
    const s = await server();
    const { ctx, run } = cli();
    const refused = await run('worker', 'pair', '--server', s.url, '--name', 'pc');
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('fornax-admin tokens invite pc --worker');
    expect(existsSync(ctx.paths.tokenFile)).toBe(false);
    s.invite('pc', 'worker');
    expect((await run('worker', 'pair', '--server', s.url, '--name', 'pc')).code).toBe(0);
    const again = await run('worker', 'pair', '--server', s.url, '--name', 'pc');
    expect(again.code).toBe(1);
    expect(again.text).toContain('--force');
  });

  test('a damaged token file does not block pair --force, but does block pairing without it', async () => {
    const s = await server();
    const { ctx, run } = cli();
    mkdirSync(dirname(ctx.paths.tokenFile), { recursive: true });
    writeFileSync(ctx.paths.tokenFile, 'garbage\n');
    s.invite('pc', 'worker');
    const blocked = await run('worker', 'pair', '--server', s.url, '--name', 'pc');
    expect(blocked.code).toBe(1);
    expect(blocked.text).toContain('--force');
    const forced = await run('worker', 'pair', '--server', s.url, '--name', 'pc', '--force');
    expect(forced.code).toBe(0);
    expect(readToken(ctx.paths)).not.toBeNull();
  });

  test('an unexpected error shows its class, not its message', async () => {
    const { ctx, run } = cli();
    ctx.makeApi = () => {
      throw new TypeError('boom at C:\secret\place');
    };
    const s = await server();
    s.invite('pc', 'worker');
    const r = await run('worker', 'pair', '--server', s.url, '--name', 'pc');
    expect(r.code).toBe(1);
    expect(r.text).toContain('TypeError');
    expect(r.text).not.toContain('secret');
  });

  test('unknown flags and words are refused with the usage', async () => {
    const { run } = cli();
    for (const argv of [['worker', '--onse'], ['doctor', '--once'], ['worker', 'queue', 'extra'], ['worker', 'pair', '--name', 'pc'], ['nonsense'], []]) {
      const r = await run(...argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.text).toContain('usage: fornax');
    }
  });

  test('a second worker on this PC refuses to start; leftovers of earlier runs are swept at start', async () => {
    const s = await server();
    const { ctx, run } = cli();
    mkdirSync(ctx.paths.configDir, { recursive: true });
    writeFileSync(ctx.paths.configFile, `server: ${s.url}\ntools:\n  node: ${JSON.stringify(process.execPath)}\n`);
    saveToken(ctx.paths, s.issueToken('pc', 'worker'));
    const held = lockWorker(ctx.paths);
    const refused = await run('worker', '--once');
    expect(refused.code).toBe(1);
    expect(refused.text).toMatch(/another fornax worker runs on this PC \(pid \d+\)/);
    if ('release' in held) held.release();
    mkdirSync(join(ctx.paths.jobsDir, 'OLDJOB', 'out'), { recursive: true });
    const served = await run('worker', '--once');
    expect(served.code).toBe(0);
    expect(existsSync(join(ctx.paths.jobsDir, 'OLDJOB'))).toBe(false);
    expect(existsSync(join(ctx.paths.dataDir, 'worker.lock'))).toBe(false);
  });

  test('commands that need pairing say how to pair', async () => {
    const { run } = cli();
    expect(await run('worker', 'queue')).toMatchObject({ code: 1, text: expect.stringContaining('fornax worker pair') });
  });
});

describe('pairing answers', () => {
  const fakeApi = (e: unknown) => ({ ping: async () => { throw e; } }) as unknown as WorkerApi;

  test('only the pending answer counts as registered; any other 403 saves nothing', async () => {
    const { ctx, run } = cli();
    ctx.makeApi = () => fakeApi(new ApiError(403, 'forbidden', 'nope'));
    const r = await run('worker', 'pair', '--server', 'http://127.0.0.1:1', '--name', 'pc');
    expect(r.code).toBe(1);
    expect(existsSync(ctx.paths.tokenFile)).toBe(false);
    expect(existsSync(ctx.paths.configFile)).toBe(false);
    ctx.makeApi = () => fakeApi(new ApiError(403, 'pending', 'waiting'));
    expect((await run('worker', 'pair', '--server', 'http://127.0.0.1:1', '--name', 'pc')).code).toBe(0);
  });

  test('a stop during the ping ends pairing without saving or an error class', async () => {
    const { ctx, run } = cli();
    const stop = new AbortController();
    ctx.signal = stop.signal;
    ctx.makeApi = () =>
      ({
        ping: async (s?: AbortSignal) => {
          stop.abort();
          if (s?.aborted) throw new DOMException('aborted', 'AbortError');
        },
      }) as unknown as WorkerApi;
    const r = await run('worker', 'pair', '--server', 'http://127.0.0.1:1', '--name', 'pc');
    expect(r.code).toBe(1);
    expect(r.text).not.toContain('unexpected');
    expect(existsSync(ctx.paths.tokenFile)).toBe(false);
  });

  test('the server is saved before the token', async () => {
    const { ctx, run } = cli();
    mkdirSync(ctx.paths.tokenFile, { recursive: true }); // writing the token file fails
    ctx.makeApi = () => fakeApi(new ApiError(403, 'pending', 'waiting'));
    const r = await run('worker', 'pair', '--server', 'http://127.0.0.1:1', '--name', 'pc', '--force');
    expect(r.code).toBe(1);
    expect(readWorkerConfig(ctx.paths).server).toBe('http://127.0.0.1:1');
  });
});

describe('signal handling', () => {
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const wire = (running: boolean) => {
    const events: string[] = [];
    const handler = makeSignalHandler({
      abort: () => events.push('abort'),
      killRunning: async () => void events.push('kill'),
      hasRunning: () => running,
      exit: (c) => events.push(`exit ${c}`),
      say: (t) => events.push(`say ${t}`),
    });
    return { handler, events };
  };

  test('the first signal stops gracefully, the second kills the tool tree and then exits 130', async () => {
    const { handler, events } = wire(true);
    handler();
    expect(events).toHaveLength(2);
    expect(events[0]).toContain('job');
    expect(events[1]).toBe('abort');
    handler();
    await tick();
    expect(events.slice(2)).toEqual(['kill', 'exit 130']);
    handler();
    await tick();
    expect(events.filter((e) => e === 'kill')).toHaveLength(1);
  });

  test('the first message is neutral when no job runs', () => {
    const { handler, events } = wire(false);
    handler();
    expect(events[0]).toMatch(/^say stopping/);
    expect(events[0]).not.toContain('job');
  });

  test('SIGINT, SIGTERM and SIGHUP (terminal or SSH closed; on Windows the console window) reach the same handler', () => {
    const proc = new EventEmitter();
    const seen: string[] = [];
    const unwire = wireSignals(proc, () => seen.push('signal'));
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) proc.emit(s);
    expect(seen).toHaveLength(3);
    unwire();
    expect(proc.eventNames()).toEqual([]);
  });

  test('killRunning ends a live tool and returns', async () => {
    const done = runProcess({ argv: [process.execPath, '-e', 'setTimeout(()=>{},60000)'], cwd: tmp(), env: process.env as Record<string, string> });
    await waitFor(() => hasRunning(), 5000, 'a running tool');
    await killRunning(2000);
    const r = await done;
    expect(r.code === 0 && r.signal === null).toBe(false);
    expect(hasRunning()).toBe(false);
  });
});
