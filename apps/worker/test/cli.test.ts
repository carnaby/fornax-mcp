import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FORNAX_VERSION, fingerprint, generateToken } from '@fornax/protocol';
import { startTestServer, type TestServer } from '@fornax/server/testing';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, type WorkerApi } from '../src/api.js';
import { consoleWriter, LEASE_STOP_SIGNALS, makeSignalHandler, runCli, TRAY_SECOND_STOP, wireSignals } from '../src/cli.js';
import { hasRunning, killRunning, runProcess } from '../src/process.js';
import type { Ctx } from '../src/commands/context.js';
import { LEASE_USAGE } from '../src/commands/lease.js';
import { readClientToken, readToken, readWorkerConfig, saveToken } from '../src/config.js';
import { writeWorkerDir } from './bundle-fixture.js';
import { FAKE_SMI, testPaths, useTempDir, waitFor, writeEchoPack } from './helpers.js';

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
    err: (l) => lines.push(l),
    // An explicit empty environment: a real FORNAX_CLIENT_TOKEN of whoever runs the tests never reaches doctor.
    env: {},
    signal: new AbortController().signal,
    clipboard: () => null,
    loopOptions: { claimWaitS: 0, checkTimeoutMs: 10_000 },
    nvidiaSmi: [process.execPath, FAKE_SMI, 'one'],
  };
  const run = async (...argv: string[]) => {
    lines.length = 0;
    const code = await runCli(argv, ctx);
    return { code, text: lines.join('\n') };
  };
  return { ctx, run };
}

describe('fornax CLI', () => {
  test('lease token: read from stdin, checked as a client token, stored; a worker token or no token is refused', async () => {
    const s = await server();
    const { ctx, run } = cli();
    mkdirSync(ctx.paths.configDir, { recursive: true });
    writeFileSync(ctx.paths.configFile, `server: ${s.url}\n`);
    const client = s.issueToken('alice');
    ctx.readStdin = async () => `${client}\r\n`;
    const saved = await run('lease', 'token');
    expect(saved.code).toBe(0);
    expect(saved.text).not.toContain(client);
    expect(readClientToken(ctx.paths, {})).toBe(client);
    ctx.readStdin = async () => s.issueToken('pc', 'worker');
    expect((await run('lease', 'token')).code).toBe(1);
    ctx.readStdin = async () => 'not a token';
    expect((await run('lease', 'token')).code).toBe(1);
    expect(readClientToken(ctx.paths, {})).toBe(client);
  });

  test('fornax lease: usage errors are 120, a missing client token 121, both before any job', async () => {
    const { ctx, run } = cli();
    mkdirSync(ctx.paths.configDir, { recursive: true });
    writeFileSync(ctx.paths.configFile, 'server: https://fornax.example.com\n');
    ctx.env = {};
    for (const argv of [
      ['lease'],
      ['lease', process.execPath],
      ['lease', '--minutes', '5', process.execPath],
      ['lease', '--'],
      ['lease', '--minutes', '0', '--', process.execPath],
      ['lease', '--minutes', '721', '--', process.execPath],
      ['lease', '--minutes', '1.5', '--', process.execPath],
      ['lease', '--wait-minutes', '0', '--', process.execPath],
      ['lease', '--priority', 'urgent', '--', process.execPath],
      ['lease', '--label', 'a;b', '--', process.execPath],
      ['lease', '--bogus', '--', process.execPath],
      ['lease', 'extra', '--', process.execPath],
      ['lease', 'token', 'extra'],
      ['lease', 'token', '--bogus'],
      ['lease', '--rerun', 'token'],
    ]) {
      const r = await run(...argv);
      expect(r.code, argv.join(' ')).toBe(120);
      expect(r.text, argv.join(' ')).toContain('usage: fornax lease');
    }
    const none = await run('lease', '--', process.execPath);
    expect(none.code).toBe(121);
    expect(none.text).toBe('fornax lease: no client token: store one with fornax lease token (or set FORNAX_CLIENT_TOKEN)');
    rmSync(ctx.paths.configFile);
    ctx.env = { FORNAX_CLIENT_TOKEN: generateToken('alice') };
    const unpaired = await run('lease', '--', process.execPath);
    expect(unpaired.code).toBe(121);
    expect(unpaired.text).toMatch(/^fornax lease: .* does not exist; pair this PC first/);
  });

  test('fornax lease --help and -h print the lease usage and exit 0; after -- they belong to the program', async () => {
    const { ctx, run } = cli();
    ctx.env = {};
    for (const flag of ['--help', '-h']) {
      expect(await run('lease', flag)).toEqual({ code: 0, text: LEASE_USAGE });
    }
    // No worker.yaml: the program's --help is not the wrapper's, so the lease is asked for (and fails here with 121).
    expect((await run('lease', '--', process.execPath, '--help')).code).toBe(121);
  });

  test('the usage of fornax and of fornax lease share the lease lines', async () => {
    const { run } = cli();
    const general = (await run('--help')).text;
    const lease = (await run('lease')).text;
    for (const line of lease.split('\n').filter((l) => l.includes('fornax lease '))) {
      expect(general).toContain(line.replace(/^usage: /, '       '));
    }
  });

  test('doctor names the client token, or says fornax lease cannot run without one', async () => {
    const s = await server();
    const { ctx, run } = cli();
    s.invite('pc', 'worker');
    await run('worker', 'pair', '--server', s.url, '--name', 'pc');
    s.approve('pc');
    ctx.env = {};
    expect((await run('doctor')).text).toMatch(/^WARN\s+no client token: fornax lease cannot run \(fornax lease token\)$/m);
    ctx.env = { FORNAX_CLIENT_TOKEN: s.issueToken('alice') };
    expect((await run('doctor')).text).toMatch(/^ok\s+client token: alice$/m);
  });

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

  test('worker --child (what an older running supervisor starts) is the worker command, and stays out of the usage', async () => {
    const { run } = cli();
    const plain = await run('worker');
    const child = await run('worker', '--child');
    expect(plain.code).toBe(1);
    expect(child).toEqual(plain);
    expect((await run('--help')).text).not.toContain('--child');
  });

  test('a second worker on this PC refuses to start; leftovers of earlier runs are swept at start', async () => {
    const s = await server();
    const { ctx, run } = cli();
    // Spec 06 3.2: the tray's `started` event hangs on this; a refused worker never started.
    let started = 0;
    ctx.onWorkerStarted = () => started++;
    mkdirSync(ctx.paths.configDir, { recursive: true });
    writeFileSync(ctx.paths.configFile, `server: ${s.url}\ntools:\n  node: ${JSON.stringify(process.execPath)}\n`);
    saveToken(ctx.paths, s.issueToken('pc', 'worker'));
    // Another worker: a live process whose pid is in a fresh lock.
    const other = spawn(process.execPath, ['-e', 'setInterval(() => 0, 1000)'], { stdio: 'ignore', windowsHide: true });
    try {
      mkdirSync(ctx.paths.dataDir, { recursive: true });
      writeFileSync(join(ctx.paths.dataDir, 'worker.lock'), String(other.pid));
      const refused = await run('worker', '--once');
      expect(refused.code).toBe(1);
      expect(refused.text).toContain(`another fornax worker runs on this PC (pid ${other.pid})`);
      expect(started).toBe(0);
    } finally {
      other.kill();
    }
    await waitFor(() => other.exitCode !== null || other.signalCode !== null, 5000, 'the other worker to end');
    mkdirSync(join(ctx.paths.jobsDir, 'OLDJOB', 'out'), { recursive: true });
    const served = await run('worker', '--once');
    expect(served.code).toBe(0);
    expect(started).toBe(1);
    expect(existsSync(join(ctx.paths.jobsDir, 'OLDJOB'))).toBe(false);
    expect(existsSync(join(ctx.paths.dataDir, 'worker.lock'))).toBe(false);
  });

  // POSIX modes only: the token file on Windows relies on the profile's ACL (out of scope).
  test.runIf(process.platform !== 'win32')('doctor warns when the token file is readable by other users', async () => {
    const { ctx, run } = cli();
    saveToken(ctx.paths, generateToken('pc'));
    expect((await run('doctor')).text).not.toMatch(/WARN\s+token file/);
    chmodSync(ctx.paths.tokenFile, 0o644);
    expect((await run('doctor')).text).toMatch(/^WARN\s+token file .* can be read or changed by other users \(mode 0644\); run chmod 600 /m);
  });

  test('doctor: says whether this fornax is the installed copy and when the server offers another version (spec 05c 5.3)', async () => {
    const zip = join(tmp(), 'fornax-worker.zip');
    writeFileSync(zip, Buffer.from('PK\u0005\u0006fake'));
    const s = await startTestServer({ workerZip: zip });
    servers.push(s);
    const { ctx, run } = cli();
    mkdirSync(ctx.paths.configDir, { recursive: true });
    writeFileSync(ctx.paths.configFile, `server: ${s.url}\n`);
    saveToken(ctx.paths, s.issueToken('pc', 'worker'));
    ctx.currentVersion = '0.0.1';
    ctx.script = join(tmp(), 'fornax.mjs');
    let r = await run('doctor');
    expect(r.text).toContain('WARN  this fornax is not installed (fornax install)');
    expect(r.text).toContain(`WARN  the server offers fornax ${FORNAX_VERSION} (you have 0.0.1): fornax update`);
    writeWorkerDir(ctx.paths.appDir, { version: '0.0.1' });
    ctx.script = join(ctx.paths.appDir, 'fornax.mjs');
    r = await run('doctor');
    expect(r.text).toContain(`ok    fornax 0.0.1 installed in ${ctx.paths.appDir}`);
  });

  test('doctor shows the card as the worker sees it; a failed reading with a limit fails', async () => {
    const { ctx, run } = cli();
    mkdirSync(ctx.paths.configDir, { recursive: true });
    writeFileSync(ctx.paths.configFile, 'server: https://fornax.example.com\ngpu:\n  max_used_mib: 2048\n');
    // No request to the example host: doctor asks the server for its bundle version.
    ctx.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    expect((await run('doctor')).text).toMatch(/^ok\s+gpu: 1130 of 16311 MiB in use, limit 2048$/m);
    ctx.nvidiaSmi = [process.execPath, FAKE_SMI, 'fail'];
    const failed = await run('doctor');
    expect(failed.text).toMatch(/^FAIL\s+gpu: nvidia-smi: exit code 9$/m);
  });

  test('commands that need pairing say how to pair', async () => {
    const { run } = cli();
    expect(await run('worker', 'queue')).toMatchObject({ code: 1, text: expect.stringContaining('fornax worker pair') });
  });
});

describe('pairing answers', () => {
  const fakeApi = (e: unknown, onPing = () => {}) => ({ ping: async () => { onPing(); throw e; } }) as unknown as WorkerApi;

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

  test('a server that lets the new token in at once did not register it: nothing is saved', async () => {
    const { ctx, run } = cli();
    ctx.makeApi = () => ({ ping: async () => {} }) as unknown as WorkerApi;
    const r = await run('worker', 'pair', '--server', 'http://127.0.0.1:1', '--name', 'pc');
    expect(r).toEqual({ code: 1, text: 'this server did not register the token; is the URL right?' });
    expect(existsSync(ctx.paths.tokenFile)).toBe(false);
    expect(existsSync(ctx.paths.configFile)).toBe(false);
  });

  test('a local problem is found before the ping, so it never uses up the invite', async () => {
    let pings = 0;
    const counting = () => ({ ping: async () => void pings++ }) as unknown as WorkerApi;

    const broken = cli();
    broken.ctx.makeApi = counting;
    mkdirSync(broken.ctx.paths.configDir, { recursive: true });
    writeFileSync(broken.ctx.paths.configFile, 'server: [\n');
    const r1 = await broken.run('worker', 'pair', '--server', 'http://127.0.0.1:1', '--name', 'pc');
    expect(r1.code).toBe(1);
    expect(r1.text).toMatch(/is not valid YAML/);

    const unwritable = cli();
    unwritable.ctx.makeApi = counting;
    // The configuration directory cannot be created: a file stands in its place.
    mkdirSync(dirname(unwritable.ctx.paths.configDir), { recursive: true });
    writeFileSync(unwritable.ctx.paths.configDir, '');
    const r2 = await unwritable.run('worker', 'pair', '--server', 'http://127.0.0.1:1', '--name', 'pc');
    expect(r2.code).toBe(1);
    expect(r2.text).toMatch(/cannot write to/);

    expect(pings).toBe(0);
  });

  test('pair --server refuses a user name, password, query or fragment; plain http to another host is warned about', async () => {
    const { ctx, run } = cli();
    let pings = 0;
    ctx.makeApi = () => fakeApi(new ApiError(403, 'pending', 'waiting'), () => pings++);
    for (const bad of ['https://u:p@fornax.example.com', 'https://u@fornax.example.com', 'https://fornax.example.com/?a=1', 'https://fornax.example.com/#x', 'https://fornax.example.com/?']) {
      const r = await run('worker', 'pair', '--server', bad, '--name', 'pc');
      expect(r.code, bad).toBe(2);
      expect(r.text).toMatch(/user name, password, query or fragment/);
    }
    expect(pings).toBe(0);
    const plain = await run('worker', 'pair', '--server', 'http://fornax.example.com', '--name', 'pc');
    expect(plain.code).toBe(0);
    expect(plain.text).toMatch(/^warning: .*http:\/\/fornax\.example\.com.* not encrypted/m);
    const local = await run('worker', 'pair', '--server', 'http://127.0.0.1:1', '--name', 'pc', '--force');
    expect(local.code).toBe(0);
    expect(local.text).not.toMatch(/warning/);
  });

  test('commands that connect warn about plain http to another host', async () => {
    const { ctx, run } = cli();
    mkdirSync(ctx.paths.configDir, { recursive: true });
    writeFileSync(ctx.paths.configFile, 'server: http://fornax.example.com\n');
    saveToken(ctx.paths, generateToken('pc'));
    ctx.makeApi = () => ({ queue: async () => ({ queued: 0, running: 0, unavailable: [] }) }) as unknown as WorkerApi;
    const r = await run('worker', 'queue');
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/^warning: .*not encrypted/m);
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
  const wire = (running: boolean, cancelGraceMs?: number) => {
    const events: string[] = [];
    const handler = makeSignalHandler({
      abort: (s) => events.push(s ? `abort ${s}` : 'abort'),
      killRunning: async () => void events.push('kill'),
      hasRunning: () => running,
      exit: (c) => events.push(`exit ${c}`),
      say: (t) => events.push(`say ${t}`),
      cancelGraceMs,
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

  test("the signal's name reaches the stop (fornax lease passes it on to its program); SIGHUP and SIGQUIT stop as SIGTERM does", () => {
    for (const s of ['SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
      const { handler, events } = wire(false);
      handler(s);
      expect(events).toContain(`abort ${s}`);
    }
  });

  test('fornax lease, no program running: the second signal waits for the cancel of the job (bounded), then exits 130', async () => {
    const { handler, events } = wire(false, 150);
    handler('SIGINT');
    handler('SIGINT');
    await tick();
    // No kill and no exit yet: the first signal's cancel is under way, and the command may end by itself meanwhile.
    expect(events.filter((e) => e === 'kill' || e.startsWith('exit'))).toEqual([]);
    await waitFor(() => events.includes('exit 130'), 2000, 'the bounded exit');
    expect(events).not.toContain('kill');
  });

  test('fornax lease with its program running: the second signal still kills it at once', async () => {
    const { handler, events } = wire(true, 60_000);
    handler('SIGINT');
    handler('SIGINT');
    await tick();
    expect(events.slice(-2)).toEqual(['kill', 'exit 130']);
  });

  test('the first message is neutral when no job runs', () => {
    const { handler, events } = wire(false);
    handler();
    expect(events[0]).toMatch(/^say stopping/);
    expect(events[0]).not.toContain('job');
  });

  test('the first message names how to quit at once: Ctrl+C on the console, a second stop under the tray', () => {
    const said = (running: boolean, secondStopHint?: string) => {
      const lines: string[] = [];
      const handler = makeSignalHandler({ abort: () => {}, killRunning: async () => {}, hasRunning: () => running, exit: () => {}, say: (t) => lines.push(t), secondStopHint });
      handler();
      return lines;
    };
    expect(said(true)).toEqual(['stopping: the running job is stopped and given back (Ctrl+C again quits at once)']);
    expect(said(false)).toEqual(['stopping (Ctrl+C again quits at once)']);
    expect(said(true, TRAY_SECOND_STOP)).toEqual(['stopping: the running job is stopped and given back (a second stop quits at once)']);
    expect(said(false, TRAY_SECOND_STOP)).toEqual(['stopping (a second stop quits at once)']);
  });

  test('a console gone with the terminal (EIO after a hangup, EPIPE) neither crashes the handler nor stops the abort', async () => {
    for (const code of ['EIO', 'EPIPE']) {
      // A terminal that hung up: every write fails, reported as a stream 'error' after the write call returned.
      const tty = new Writable({ write: (_chunk, _enc, cb) => cb(Object.assign(new Error(`write ${code}`), { code })) });
      const say = consoleWriter(tty);
      const events: string[] = [];
      const handler = makeSignalHandler({
        abort: () => events.push('abort'),
        killRunning: async () => void events.push('kill'),
        hasRunning: () => true,
        exit: (c) => events.push(`exit ${c}`),
        say: (t) => say(`${t}\n`),
      });
      handler();
      await tick();
      expect(events).toEqual(['abort']);
      say('more output after the hangup\n');
      await tick();
      handler();
      await tick();
      expect(events).toEqual(['abort', 'kill', 'exit 130']);
    }
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

  test("fornax lease also stops on SIGQUIT (Ctrl+\\ on Linux; its program is out of the terminal's reach)", () => {
    const proc = new EventEmitter();
    const seen: (string | undefined)[] = [];
    const unwire = wireSignals(proc, (s) => seen.push(s), LEASE_STOP_SIGNALS);
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) proc.emit(s, s);
    expect(seen).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);
    unwire();
    expect(proc.eventNames()).toEqual([]);
    // The worker itself keeps the default SIGQUIT.
    const plain = new EventEmitter();
    wireSignals(plain, () => {});
    expect(plain.eventNames()).not.toContain('SIGQUIT');
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

test('fornax --version prints the version', async () => {
  const { run } = cli();
  expect(await run('--version')).toEqual({ code: 0, text: FORNAX_VERSION });
});
