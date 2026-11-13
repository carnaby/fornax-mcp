import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { childEnv, hasRunning, killRunning, LOG_LIMIT, LogBuffer, logTail, parseProgress, type RunOptions, runProcess } from '../src/process.js';
import { FAKE_TOOL, isAlive, readPids, useTempDir, waitFor } from './helpers.js';

const tmp = useTempDir();
const tool = (...args: string[]) => [process.execPath, FAKE_TOOL, ...args];
const run = (argv: string[], extra: Partial<RunOptions> = {}) => runProcess({ argv, cwd: tmp(), env: childEnv(process.env, {}), ...extra });

describe('runProcess', () => {
  test('progress lines go to onProgress, everything else to the log; the exit code comes back', async () => {
    const seen: unknown[] = [];
    const r = await run(tool('talk', '1'), { onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([{ progress: 0.5, message: 'half' }, { progress: 1, message: null }]);
    expect(r).toMatchObject({ code: 1, signal: null, timedOut: false, canceled: false, spawnError: null });
    expect(r.log).toContain('starting\n');
    expect(r.log).toContain('{"progress": 2}');
    expect(r.log).toContain('a warning');
    expect(r.log).not.toContain('half');
  });

  test('arguments arrive exactly as given: no shell, no splitting, no expansion', async () => {
    const args = ['a b', '"quoted"', 'x;y', '$HOME', '%PATH%', 'back\\slash\\', '', 'é ü'];
    const r = await run(tool('argv', ...args));
    expect(JSON.parse(r.log.trim())).toEqual(args);
  });

  test('the tool never sees FORNAX_* variables except the three it is given', async () => {
    const env = childEnv({ ...process.env, FORNAX_TOKEN: 'secret', fornax_other: 'x' }, { FORNAX_JOB_ID: 'J1', FORNAX_OUT: 'o', FORNAX_WORK: 'w' });
    const r = await runProcess({ argv: tool('env'), cwd: tmp(), env });
    expect(JSON.parse(r.log.trim())).toEqual(['FORNAX_JOB_ID', 'FORNAX_OUT', 'FORNAX_WORK']);
  });

  test('runs in the given working directory', async () => {
    const cwd = tmp();
    const r = await runProcess({ argv: tool('cwd'), cwd, env: childEnv(process.env, {}) });
    expect(realpathSync(r.log.trim())).toBe(realpathSync(cwd));
  });

  test('a program that does not exist is reported, not thrown', async () => {
    const r = await run(['fornax-test-no-such-program']);
    expect(r.spawnError).toMatch(/ENOENT/);
    expect(r.code).toBeNull();
  });

  test('a spawn that throws synchronously is reported, not thrown', async () => {
    // A NUL byte in the program path makes spawn throw on every platform.
    const nul = await run([`fornax-test\0program`]);
    expect(nul.spawnError).toEqual(expect.any(String));
    expect(nul).toMatchObject({ code: null, timedOut: false, canceled: false });
    if (process.platform === 'win32') {
      // Windows refuses a .cmd/.bat without a shell (EINVAL) with a synchronous throw.
      const script = join(tmp(), 'tool.cmd');
      writeFileSync(script, '@echo off\r\n');
      const cmd = await run([script]);
      expect(cmd.spawnError).toMatch(/EINVAL/);
      expect(cmd.code).toBeNull();
    }
  });

  test('max runtime: the process is stopped and timedOut is set', async () => {
    const started = Date.now();
    const r = await run(tool('sleep'), { timeoutMs: 300, killGraceMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('cancel kills the whole tree, grandchild included (Windows: taskkill /T; Linux: the process group)', async () => {
    const pidFile = join(tmp(), 'pids.json');
    const stop = new AbortController();
    const running = run(tool('tree', pidFile), { signal: stop.signal, killGraceMs: 500 });
    const pids = await waitFor(() => readPids(pidFile), 10_000, 'the tool to write its pids');
    expect(isAlive(pids.parent) && isAlive(pids.child)).toBe(true);
    stop.abort();
    const r = await running;
    expect(r.canceled).toBe(true);
    await waitFor(() => !isAlive(pids.parent) && !isAlive(pids.child), 5000, 'the tree to die');
  });

  // Linux only: Windows has no process groups here (no Job Objects in this plan); a leftover there is handled by the job directory check.
  test.runIf(process.platform !== 'win32')('Linux: a grandchild left behind by a tool that exited 0 is ended with its process group', async () => {
    const pidFile = join(tmp(), 'pids.json');
    let pids: { parent: number; child: number } | null = null;
    try {
      const r = await run(tool('orphan', pidFile), { killGraceMs: 500 });
      expect(r.code).toBe(0);
      pids = readPids(pidFile)!;
      // Killed (SIGKILL after the grace period); allow its new parent a moment to reap it.
      await waitFor(() => !isAlive(pids!.child), 3000, 'the grandchild to be gone');
    } finally {
      if (pids && isAlive(pids.child)) process.kill(pids.child, 'SIGKILL');
    }
  });

  test.runIf(process.platform !== 'win32')('Linux: a group still being ended after the exit stays registered, so a hard quit reaches it', async () => {
    const pidFile = join(tmp(), 'pids.json');
    const running = run(tool('orphan', pidFile), { killGraceMs: 20_000 });
    const pids = await waitFor(() => readPids(pidFile), 10_000, 'the tool to write its pids');
    try {
      await waitFor(() => !isAlive(pids.parent), 5000, 'the tool to exit');
      expect(hasRunning()).toBe(true);
      const started = Date.now();
      await killRunning(1000);
      await running;
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(hasRunning()).toBe(false);
      await waitFor(() => !isAlive(pids.child), 3000, 'the grandchild to be gone');
    } finally {
      if (isAlive(pids.child)) process.kill(pids.child, 'SIGKILL');
    }
  });

  test('an already aborted signal starts nothing', async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await run(tool('sleep'), { signal: stop.signal })).toMatchObject({ canceled: true, code: null, log: '' });
  });
});

describe('log', () => {
  test('keeps the last 1 MiB without splitting a character', () => {
    const log = new LogBuffer();
    for (let i = 0; i < 6000; i++) log.push(`${'é'.repeat(100)}\n`);
    log.push('END');
    const text = log.toString();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LOG_LIMIT);
    expect(Buffer.byteLength(text)).toBeGreaterThan(LOG_LIMIT - 4);
    expect(text.endsWith('END')).toBe(true);
    expect(text.includes('�')).toBe(false);
  });

  test('logTail is the last non-empty line', () => {
    expect(logTail('a\nlast one\n\n')).toBe('last one');
    expect(logTail('')).toBe('');
  });
});

describe('parseProgress', () => {
  test('only the exact shape counts', () => {
    expect(parseProgress('{"progress": 0.4, "message": "frame 3/10"}')).toEqual({ progress: 0.4, message: 'frame 3/10' });
    expect(parseProgress('  {"progress": 0}  ')).toEqual({ progress: 0, message: null });
    for (const no of ['{"progress": 1.5}', '{"progress": "0.4"}', '{"progress": 0.4, "x": 1}', '{"progress": 0.4, "message": 3}', 'progress 0.4', '{oops}', '[0.4]']) {
      expect(parseProgress(no), no).toBeNull();
    }
    expect(parseProgress(JSON.stringify({ progress: 0.1, message: 'x'.repeat(300) }))?.message).toHaveLength(200);
  });
});

describe('kill fallback', () => {
  // The seams make the tree kill fail on either platform (Windows: taskkill cannot start; Linux: the group signal throws
  // EPERM); the tool itself must still be stopped and runProcess must resolve.
  test('a failing tree kill falls back to killing the process itself', async () => {
    const pidFile = join(tmp(), 'pids.json');
    const stop = new AbortController();
    const running = run(tool('tree', pidFile), { signal: stop.signal, killGraceMs: 500, taskkillProgram: 'fornax-test-no-such-taskkill',
      signalGroup: () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
    });
    const pids = await waitFor(() => readPids(pidFile), 10_000, 'the tool to write its pids');
    stop.abort();
    const r = await Promise.race([running, new Promise<'hung'>((res) => setTimeout(() => res('hung'), 8000))]);
    expect(r).toMatchObject({ canceled: true });
    await waitFor(() => !isAlive(pids.parent), 5000, 'the tool to die');
    // Clean up the grandchild, which the fallback cannot reach.
    try {
      process.kill(pids.child);
    } catch {
      // already gone
    }
  }, 20_000);
});
