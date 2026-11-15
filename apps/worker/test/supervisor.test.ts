import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { superviseWorker, watchParent } from '../src/supervisor.js';
import { useTempDir, waitFor } from './helpers.js';

const tmp = useTempDir();
const WIRED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGBREAK'];
const CHILD = fileURLToPath(new URL('./fixtures/supervised-child.mjs', import.meta.url));
/** Every child the supervisor started; one still running after a test (a failed one) is killed. */
const started: ChildProcess[] = [];
afterEach(() => {
  for (const c of started.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

/** The child's state file; empty until the child wrote it. */
function state(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function supervise(mode: string, extra: Partial<Parameters<typeof superviseWorker>[0]> = {}) {
  const file = join(tmp(), 'state');
  const out: string[] = [];
  const signals = new EventEmitter();
  const done = superviseWorker({
    execPath: process.execPath,
    execArgv: [],
    script: CHILD,
    args: [mode, file],
    out: (l) => out.push(l),
    signals,
    ...extra,
    onChild: (c) => {
      started.push(c);
      extra.onChild?.(c);
    },
  });
  return { file, out, signals, done };
}

describe('superviseWorker', () => {
  test('exit 75 starts the worker again; its next exit code is the supervisor\'s', async () => {
    const { file, done } = supervise('restart-once');
    expect(await done).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('2');
  });

  test('another exit code ends the supervisor with it, without a restart; its signal handlers are gone after', async () => {
    const { signals, done } = supervise('exit-3');
    expect(await done).toBe(3);
    for (const s of WIRED) expect(signals.listenerCount(s), s).toBe(0);
  });

  test('more than 3 restarts in a minute: it stops and says why', async () => {
    const { out, done } = supervise('always-75');
    expect(await done).toBe(1);
    expect(out).toContain('the worker asked to restart 4 times in a minute; not restarting');
  });

  test('restarts older than the window do not count', async () => {
    let t = 0;
    const { file, out, done } = supervise('restart-5', { now: () => (t += 61_000) });
    expect(await done).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('6');
    expect(out).toEqual([]);
  });

  test('a stop asked for while the worker restarts is kept: exit 75 then ends the supervisor with 0', async () => {
    const { file, signals, done } = supervise('slow-75');
    await waitFor(() => state(file) === '1', 10_000, 'the child');
    expect(signals.listenerCount('SIGINT')).toBe(1);
    signals.emit('SIGINT', 'SIGINT');
    expect(await done).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('1');
    expect(started).toHaveLength(1);
    for (const s of WIRED) expect(signals.listenerCount(s), s).toBe(0);
  });

  test.runIf(process.platform !== 'win32')('Linux: every signal the supervisor gets is passed on once; the child counts them as the worker does', async () => {
    const { file, signals, done } = supervise('signal');
    await waitFor(() => state(file) === 'ready', 10_000, 'the child');
    signals.emit('SIGTERM', 'SIGTERM');
    await waitFor(() => state(file) === 'SIGTERM', 10_000, 'the first signal');
    signals.emit('SIGINT', 'SIGINT');
    expect(await done).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('SIGTERM,SIGINT');
  });

  test.runIf(process.platform !== 'win32')('Linux: SIGQUIT reaches the child as SIGTERM (a graceful stop)', async () => {
    const { file, signals, done } = supervise('signal');
    await waitFor(() => state(file) === 'ready', 10_000, 'the child');
    signals.emit('SIGQUIT', 'SIGQUIT');
    await waitFor(() => state(file) === 'SIGTERM', 10_000, 'the first signal');
    signals.emit('SIGINT', 'SIGINT');
    expect(await done).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('SIGTERM,SIGINT');
  });

  test.runIf(process.platform === 'win32')('Windows: Ctrl+C reaches the child from the console; the supervisor passes nothing on', async () => {
    let child: ChildProcess | undefined;
    const { file, signals, done } = supervise('signal', { onChild: (c) => (child = c) });
    await waitFor(() => state(file) === 'ready', 10_000, 'the child');
    signals.emit('SIGINT', 'SIGINT');
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(file, 'utf8')).toBe('ready');
    child!.kill();
    await done;
  });
});

describe('watchParent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('the parent pid changes: onGone is called exactly once', () => {
    vi.useFakeTimers();
    let ppid = 100;
    const onGone = vi.fn();
    const stop = watchParent({ getPpid: () => ppid, onGone });
    vi.advanceTimersByTime(4000);
    expect(onGone).not.toHaveBeenCalled();
    ppid = 1;
    vi.advanceTimersByTime(2000);
    expect(onGone).toHaveBeenCalledTimes(1);
    ppid = 2;
    vi.advanceTimersByTime(10_000);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  test('the parent stays: onGone is never called', () => {
    vi.useFakeTimers();
    const onGone = vi.fn();
    const stop = watchParent({ getPpid: () => 100, onGone });
    vi.advanceTimersByTime(60_000);
    expect(onGone).not.toHaveBeenCalled();
    stop();
  });

  test('the stop clears the timer', () => {
    vi.useFakeTimers();
    let ppid = 100;
    const onGone = vi.fn();
    const stop = watchParent({ getPpid: () => ppid, onGone });
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    ppid = 1;
    vi.advanceTimersByTime(10_000);
    expect(onGone).not.toHaveBeenCalled();
  });
});
