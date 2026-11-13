import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fingerprint } from '@fornax/protocol';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { Ctx } from '../src/commands/context.js';
import { readToken, readWorkerConfig } from '../src/config.js';
import { testPaths, useTempDir, writeEchoPack } from './helpers.js';

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

  test('commands that need pairing say how to pair', async () => {
    const { run } = cli();
    expect(await run('worker', 'queue')).toMatchObject({ code: 1, text: expect.stringContaining('fornax worker pair') });
  });
});
