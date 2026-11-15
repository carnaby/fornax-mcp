import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { superviseWorker } from '../src/supervisor.js';
import { useTempDir, waitFor } from './helpers.js';

const tmp = useTempDir();
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

  test('another exit code ends the supervisor with it, without a restart', async () => {
    expect(await supervise('exit-3').done).toBe(3);
  });

  test('more than 3 restarts in a minute: it stops and says why', async () => {
    const { out, done } = supervise('always-75');
    expect(await done).toBe(1);
    expect(out).toContain('the worker asked to restart 4 times in a minute; not restarting');
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
