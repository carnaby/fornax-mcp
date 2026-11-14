import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientJobView } from '@fornax/protocol';
import { describe, expect, test } from 'vitest';
import { ApiError, NetworkError } from '../src/api.js';
import { type LeaseClient, type LeaseRequest, type LeaseTimings, runLease } from '../src/lease/run.js';
import { isAlive, LEASE_PROGRAM, processGroupOf, readJson, readPids, useTempDir, waitFor } from './helpers.js';

const tmp = useTempDir();
const ID = '01JLEASERUN000000000000000';
const STARTED = '2026-11-14T10:00:00.000Z';
const LATER = '2026-11-14T10:05:00.000Z';
const NESTED = { ...process.env, FORNAX_LEASE: ID };
const NETWORK_DOWN = () => Array.from({ length: 1000 }, () => new NetworkError('cannot reach the server: ECONNREFUSED'));

/** A stand-in for the client API: the test moves the job; a GET with ?wait answers on a change, as the server does. */
function fakeServer() {
  let n = 0;
  let job: ClientJobView = {
    id: ID, type: 'lease', state: 'queued', started_at: null, finished_at: null, position: 1, error: null,
    change: 'c0', note: 'waiting, position 1; the worker takes it next',
  };
  const wakes = new Set<() => void>();
  const calls: string[] = [];
  /** Thrown by the next calls, in turn. */
  const failures: Error[] = [];
  const set = (patch: Partial<ClientJobView>) => {
    job = { ...job, ...patch, change: `c${++n}` };
    for (const w of [...wakes]) w();
  };
  const next = () => {
    const e = failures.shift();
    if (e) throw e;
  };
  const api: LeaseClient = {
    async submit() {
      calls.push('submit');
      next();
      return { ...job };
    },
    async job(_id, o = {}) {
      calls.push('job');
      next();
      if (o.wait && o.change === job.change) {
        await new Promise<void>((resolve) => {
          const done = () => {
            wakes.delete(done);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, o.wait! * 1000);
          wakes.add(done);
          o.signal?.addEventListener('abort', done, { once: true });
        });
      }
      if (o.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return { ...job };
    },
    async cancel() {
      calls.push('cancel');
      if (job.state === 'queued' || job.state === 'running') set({ state: 'canceled', finished_at: new Date().toISOString() });
      return { ...job };
    },
  };
  return { api, set, calls, failures, get job() { return job; } };
}

const fast: LeaseTimings = { pollS: 1, aliveMs: 50, noteMs: 60_000, interruptMs: 300, killGraceMs: 300, minuteMs: 60_000, backoff: { baseMs: 10, maxMs: 40 } };

/** runLease with the test program; `args` go to the program. */
function lease(
  server: ReturnType<typeof fakeServer>, args: string[], o: Partial<LeaseRequest> = {},
  extra: {
    env?: NodeJS.ProcessEnv; signal?: AbortSignal; timings?: Partial<LeaseTimings>; leasesDir?: string; onLine?: (line: string) => void;
  } = {},
) {
  const lines: string[] = [];
  const leasesDir = extra.leasesDir ?? join(tmp(), 'leases');
  const run = runLease(
    { minutes: 60, waitMinutes: null, rerun: false, priority: 'normal', label: null, program: process.execPath, args: [LEASE_PROGRAM, ...args], ...o },
    {
      api: server.api, leasesDir, signal: extra.signal ?? new AbortController().signal,
      say: (l) => {
        lines.push(l);
        extra.onLine?.(l);
      },
      env: extra.env ?? process.env, cwd: tmp(), timings: { ...fast, ...extra.timings },
    },
  );
  return { run, lines, dir: join(leasesDir, ID) };
}

describe('runLease', () => {
  test('queued, then running: the program runs under the lease, its exit code comes back, alive and done name the claim', async () => {
    const s = fakeServer();
    const report = join(tmp(), 'report.json');
    const l = lease(s, ['--report', report, '--exit', '7'], {}, { env: { ...process.env, FORNAX_CLIENT_TOKEN: 'secret' } });
    await waitFor(() => s.calls.includes('job'), 5000, 'the wait');
    expect(existsSync(report)).toBe(false);
    s.set({ state: 'running', started_at: STARTED, note: null, position: null });
    expect(await l.run).toBe(7);
    const r = readJson<{ lease: string; fornax: string[] }>(report)!;
    expect(r.lease).toBe(ID);
    expect(r.fornax).toContain('FORNAX_LEASE');
    expect(r.fornax).not.toContain('FORNAX_CLIENT_TOKEN');
    expect(readFileSync(join(l.dir, 'alive'), 'utf8')).toBe(STARTED);
    expect(readFileSync(join(l.dir, 'done'), 'utf8')).toBe(STARTED);
    expect(l.lines[0]).toBe('fornax lease: waiting, position 1; the worker takes it next');
  });

  test('a changed note is shown at once', async () => {
    const s = fakeServer();
    const l = lease(s, ['--exit', '0']);
    await waitFor(() => s.calls.includes('job'), 5000, 'the wait');
    s.set({ note: 'waiting: the worker is offline since 13:40 UTC; the job starts when the worker runs again, asking again changes nothing' });
    await waitFor(() => l.lines.length === 2, 5000, 'the second note');
    expect(l.lines[1]).toContain('offline since 13:40 UTC');
    s.set({ state: 'running', started_at: STARTED });
    expect(await l.run).toBe(0);
  });

  test('an unreachable server at submit is retried with one line; then the lease goes on', async () => {
    const s = fakeServer();
    s.failures.push(new NetworkError('cannot reach the server: ECONNREFUSED'), new NetworkError('cannot reach the server: ECONNREFUSED'));
    const l = lease(s, ['--exit', '0']);
    await waitFor(() => s.calls.filter((c) => c === 'submit').length === 3, 5000, 'the third submit');
    s.set({ state: 'running', started_at: STARTED });
    expect(await l.run).toBe(0);
    expect(l.lines.filter((x) => x === 'fornax lease: the server cannot be reached, retrying')).toHaveLength(1);
  });

  test('no lease: a refused token, a type not offered, any other refusal: 121, one line each', async () => {
    const cases: [ApiError, string][] = [
      [new ApiError(401, 'unauthorized', 'unauthorized'), 'fornax lease: the client token was refused (store a new one with fornax lease token)'],
      [
        new ApiError(422, 'unprocessable', 'job type lease is not offered now; list_job_types shows what is'),
        'fornax lease: the worker does not offer the job type lease: run fornax types install lease on the worker PC, then restart the worker',
      ],
      [new ApiError(429, 'too_many', 'at most 50 jobs may wait or run per token'), 'fornax lease: the server refused the lease: at most 50 jobs may wait or run per token'],
    ];
    for (const [error, text] of cases) {
      const s = fakeServer();
      s.failures.push(error);
      const l = lease(s, ['--exit', '0']);
      expect(await l.run).toBe(121);
      expect(l.lines).toEqual([text]);
    }
  });

  test('a program that cannot run: 120 before any job', async () => {
    const s = fakeServer();
    const l = lease(s, [], { program: join(tmp(), 'missing-program'), args: [] });
    expect(await l.run).toBe(120);
    expect(s.calls).toEqual([]);
    expect(l.lines[0]).toMatch(/^fornax lease: .*missing-program was not found$/);
  });

  test('--wait-minutes: gives up, cancels the job, 122', async () => {
    const s = fakeServer();
    const l = lease(s, ['--exit', '0'], { waitMinutes: 2 }, { timings: { minuteMs: 100 } });
    expect(await l.run).toBe(122);
    expect(s.job.state).toBe('canceled');
    expect(l.lines.at(-1)).toBe('fornax lease: gave up waiting after 2 min; the job was canceled');
  });

  test('canceled while waiting: 123, the program never ran', async () => {
    const s = fakeServer();
    const report = join(tmp(), 'report.json');
    const l = lease(s, ['--report', report]);
    await waitFor(() => s.calls.includes('job'), 5000, 'the wait');
    s.set({ state: 'canceled' });
    expect(await l.run).toBe(123);
    expect(existsSync(report)).toBe(false);
    expect(l.lines.at(-1)).toBe('fornax lease: the lease ended before the program started: the job was canceled');
  });

  test('canceled while the program runs: the tree is killed, done is written, 123', async () => {
    const s = fakeServer();
    const pids = join(tmp(), 'pids.json');
    const l = lease(s, ['--tree', pids, '--forever']);
    s.set({ state: 'running', started_at: STARTED });
    const { parent, child } = await waitFor(() => readPids(pids), 10_000, 'the program');
    s.set({ state: 'canceled' });
    expect(await l.run).toBe(123);
    await waitFor(() => !isAlive(parent) && !isAlive(child), 5000, 'the tree to die');
    expect(readFileSync(join(l.dir, 'done'), 'utf8')).toBe(STARTED);
    expect(l.lines.at(-1)).toBe('fornax lease: the lease was lost: the job was canceled; the program was stopped');
  });

  test('the worker gives the lease back: without --rerun the program is stopped and the job canceled, 123, no done', async () => {
    const s = fakeServer();
    const pids = join(tmp(), 'pids.json');
    const l = lease(s, ['--tree', pids, '--forever']);
    s.set({ state: 'running', started_at: STARTED });
    const { parent, child } = await waitFor(() => readPids(pids), 10_000, 'the program');
    s.set({ state: 'queued', started_at: null });
    expect(await l.run).toBe(123);
    await waitFor(() => !isAlive(parent) && !isAlive(child), 5000, 'the tree to die');
    expect(existsSync(join(l.dir, 'done'))).toBe(false);
    expect(s.job.state).toBe('canceled');
    expect(l.lines.at(-1)).toBe('fornax lease: the lease was lost: the worker gave it back (it stopped or restarted); the program was stopped');
  });

  test('given back and taken again between two answers counts as given back', async () => {
    const s = fakeServer();
    const pids = join(tmp(), 'pids.json');
    const l = lease(s, ['--tree', pids, '--forever']);
    s.set({ state: 'running', started_at: STARTED });
    const { parent, child } = await waitFor(() => readPids(pids), 10_000, 'the program');
    s.set({ state: 'running', started_at: LATER });
    expect(await l.run).toBe(123);
    await waitFor(() => !isAlive(parent) && !isAlive(child), 5000, 'the tree to die');
    expect(existsSync(join(l.dir, 'done'))).toBe(false);
    expect(s.job.state).toBe('canceled');
  });

  test('--rerun: the program stops when the lease is given back and starts again with the next claim', async () => {
    const s = fakeServer();
    const runs = join(tmp(), 'runs.txt');
    const l = lease(s, ['--runs', runs, '--sleep', '1500', '--exit', '5'], { rerun: true });
    s.set({ state: 'running', started_at: STARTED });
    await waitFor(() => existsSync(runs), 10_000, 'the first run');
    s.set({ state: 'queued', started_at: null });
    await waitFor(() => l.lines.includes('fornax lease: the worker gave the lease back; the program will start again when the lease returns'), 5000, 'the line');
    expect(s.job.state).toBe('queued');
    s.set({ state: 'running', started_at: LATER });
    expect(await l.run).toBe(5);
    expect(readFileSync(runs, 'utf8').split('\n').filter((x) => x.includes(' start '))).toHaveLength(2);
    expect(readFileSync(join(l.dir, 'alive'), 'utf8')).toBe(LATER);
    expect(readFileSync(join(l.dir, 'done'), 'utf8')).toBe(LATER);
  });

  test('--rerun does not outlive a cancel: 123', async () => {
    const s = fakeServer();
    const pids = join(tmp(), 'pids.json');
    const l = lease(s, ['--tree', pids, '--forever'], { rerun: true });
    s.set({ state: 'running', started_at: STARTED });
    await waitFor(() => readPids(pids), 10_000, 'the program');
    s.set({ state: 'canceled' });
    expect(await l.run).toBe(123);
  });

  test('--minutes: the program is stopped, done is written, 123, also with --rerun', async () => {
    const s = fakeServer();
    const pids = join(tmp(), 'pids.json');
    const l = lease(s, ['--tree', pids, '--forever'], { minutes: 1, rerun: true }, { timings: { minuteMs: 500 } });
    s.set({ state: 'running', started_at: STARTED });
    const { parent, child } = await waitFor(() => readPids(pids), 10_000, 'the program');
    expect(await l.run).toBe(123);
    await waitFor(() => !isAlive(parent) && !isAlive(child), 5000, 'the tree to die');
    expect(readFileSync(join(l.dir, 'done'), 'utf8')).toBe(STARTED);
    expect(l.lines.at(-1)).toBe('fornax lease: the lease time ran out (1 min); the program was stopped');
  });

  test('the server unreachable while the program runs: it goes on', async () => {
    const s = fakeServer();
    const report = join(tmp(), 'report.json');
    const l = lease(s, ['--report', report, '--sleep', '2500', '--exit', '3']);
    s.set({ state: 'running', started_at: STARTED });
    await waitFor(() => readJson(report), 10_000, 'the program');
    for (let i = 0; i < 3; i++) s.failures.push(new NetworkError('cannot reach the server: ECONNRESET'));
    expect(await l.run).toBe(3);
    expect(l.lines).toContain('fornax lease: the server cannot be reached; the program goes on, retrying');
  });

  test('Ctrl+C while waiting: the job is canceled, 130', async () => {
    const s = fakeServer();
    const stop = new AbortController();
    const l = lease(s, ['--exit', '0'], {}, { signal: stop.signal });
    await waitFor(() => s.calls.includes('job'), 5000, 'the wait');
    stop.abort('SIGINT');
    expect(await l.run).toBe(130);
    expect(s.job.state).toBe('canceled');
  });

  test('Ctrl+C while the program runs: it is stopped (Linux: by the signal passed on; Windows: after the grace), done, 130', async () => {
    const s = fakeServer();
    const stop = new AbortController();
    const pids = join(tmp(), 'pids.json');
    const l = lease(s, ['--tree', pids, '--forever'], {}, { signal: stop.signal });
    s.set({ state: 'running', started_at: STARTED });
    const { parent, child } = await waitFor(() => readPids(pids), 10_000, 'the program');
    stop.abort('SIGINT');
    expect(await l.run).toBe(130);
    await waitFor(() => !isAlive(parent) && !isAlive(child), 5000, 'the tree to die');
    expect(readFileSync(join(l.dir, 'done'), 'utf8')).toBe(STARTED);
  });

  test('SIGTERM and SIGHUP (a closed terminal) while the program runs: it is stopped as on Ctrl+C, done, 130', async () => {
    for (const signal of ['SIGTERM', 'SIGHUP']) {
      const s = fakeServer();
      const stop = new AbortController();
      const pids = join(tmp(), 'pids.json');
      const l = lease(s, ['--tree', pids, '--forever'], {}, { signal: stop.signal });
      s.set({ state: 'running', started_at: STARTED });
      const { parent, child } = await waitFor(() => readPids(pids), 10_000, 'the program');
      stop.abort(signal);
      expect(await l.run, signal).toBe(130);
      await waitFor(() => !isAlive(parent) && !isAlive(child), 5000, 'the tree to die');
      expect(readFileSync(join(l.dir, 'done'), 'utf8')).toBe(STARTED);
    }
  });

  test('nested: inside a running lease the program runs at once without a new job; inside one that ended: 123', async () => {
    const s = fakeServer();
    s.set({ state: 'running', started_at: STARTED });
    const l = lease(s, ['--exit', '4'], {}, { env: { ...process.env, FORNAX_LEASE: ID } });
    expect(await l.run).toBe(4);
    expect(s.calls).toEqual(['job']);
    expect(existsSync(l.dir)).toBe(false);
    const ended = fakeServer();
    ended.set({ state: 'canceled' });
    expect(await lease(ended, ['--exit', '0'], {}, { env: { ...process.env, FORNAX_LEASE: ID } }).run).toBe(123);
  });

  test('--wait-minutes also ends a wait while the server cannot be reached: 122, the job canceled', async () => {
    const s = fakeServer();
    const l = lease(s, ['--exit', '0'], { waitMinutes: 1 }, { timings: { minuteMs: 1500 } });
    await waitFor(() => s.calls.includes('job'), 5000, 'the wait');
    s.failures.push(...NETWORK_DOWN());
    s.set({ note: 'waiting, position 2; the worker takes the jobs ahead first' });
    expect(await l.run).toBe(122);
    expect(s.job.state).toBe('canceled');
    expect(l.lines).toContain('fornax lease: the server cannot be reached, retrying');
    expect(l.lines.at(-1)).toBe('fornax lease: gave up waiting after 1 min; the job was canceled');
  });

  test('--wait-minutes also ends the retries of the submit: 122, no job', async () => {
    const s = fakeServer();
    s.failures.push(...NETWORK_DOWN());
    const l = lease(s, ['--exit', '0'], { waitMinutes: 1 }, { timings: { minuteMs: 300 } });
    expect(await l.run).toBe(122);
    expect(new Set(s.calls)).toEqual(new Set(['submit']));
    expect(l.lines).toEqual(['fornax lease: the server cannot be reached, retrying', 'fornax lease: gave up waiting after 1 min; the server cannot be reached']);
  });

  test('a cancel that is refused is said so, never "the job was canceled"', async () => {
    const s = fakeServer();
    s.api.cancel = async () => {
      throw new ApiError(401, 'unauthorized', 'unauthorized');
    };
    const l = lease(s, ['--exit', '0'], { waitMinutes: 2 }, { timings: { minuteMs: 100 } });
    expect(await l.run).toBe(122);
    expect(s.job.state).toBe('queued');
    expect(l.lines.at(-1)).toBe(
      'fornax lease: gave up waiting after 2 min; the job could not be canceled (the client token was refused); a lease nobody uses ends itself within a minute',
    );
  });

  test('the queue note is shown again after noteMs while nothing changes: the long-poll waits no longer than that', async () => {
    const s = fakeServer();
    const l = lease(s, ['--exit', '0'], {}, { timings: { pollS: 25, noteMs: 1500 } });
    await waitFor(() => l.lines.length >= 2, 6000, 'the note again');
    expect(l.lines.slice(0, 2)).toEqual(Array(2).fill('fornax lease: waiting, position 1; the worker takes it next'));
    s.set({ state: 'running', started_at: STARTED });
    expect(await l.run).toBe(0);
  });

  test('the job gone while waiting: 123', async () => {
    const s = fakeServer();
    const l = lease(s, ['--exit', '0']);
    await waitFor(() => s.calls.includes('job'), 5000, 'the wait');
    s.failures.push(new ApiError(404, 'not_found', 'job not found'));
    s.set({ note: 'waiting, position 2; the worker takes the jobs ahead first' });
    expect(await l.run).toBe(123);
    expect(l.lines.at(-1)).toBe(`fornax lease: the lease ended before the program started: job ${ID} is gone`);
  });

  test('an unexpected error while waiting cancels the job, then comes out', async () => {
    const s = fakeServer();
    const l = lease(s, ['--exit', '0']);
    await waitFor(() => s.calls.includes('job'), 5000, 'the wait');
    s.failures.push(new Error('something unexpected'));
    s.set({ note: 'waiting, position 2; the worker takes the jobs ahead first' });
    await expect(l.run).rejects.toThrow('something unexpected');
    expect(s.job.state).toBe('canceled');
  });

  test('alive cannot be written: one line, the job canceled, 121, the program never runs', async () => {
    const s = fakeServer();
    const leasesDir = join(tmp(), 'leases');
    writeFileSync(leasesDir, 'not a folder');
    const report = join(tmp(), 'report.json');
    const l = lease(s, ['--report', report], {}, { leasesDir });
    s.set({ state: 'running', started_at: STARTED });
    expect(await l.run).toBe(121);
    expect(existsSync(report)).toBe(false);
    expect(s.job.state).toBe('canceled');
    expect(l.lines.at(-1)).toMatch(/^fornax lease: the lease files cannot be written in .+; the job was canceled$/);
  });

  test('failed while the program runs: the tree is killed, done is written, 123, the error in the line', async () => {
    const s = fakeServer();
    const pids = join(tmp(), 'pids.json');
    const l = lease(s, ['--tree', pids, '--forever']);
    s.set({ state: 'running', started_at: STARTED });
    const { parent, child } = await waitFor(() => readPids(pids), 10_000, 'the program');
    s.set({ state: 'failed', error: 'the lease tool ended: alive is missing' });
    expect(await l.run).toBe(123);
    await waitFor(() => !isAlive(parent) && !isAlive(child), 5000, 'the tree to die');
    expect(readFileSync(join(l.dir, 'done'), 'utf8')).toBe(STARTED);
    expect(l.lines.at(-1)).toBe('fornax lease: the lease was lost: the job failed (the lease tool ended: alive is missing); the program was stopped');
  });

  test('the token refused or the job gone while the program runs: the tree is killed, done is written, 123', async () => {
    const cases: [ApiError, string][] = [
      [new ApiError(401, 'unauthorized', 'unauthorized'), 'fornax lease: the lease was lost: the client token was refused; the program was stopped'],
      [new ApiError(404, 'not_found', 'job not found'), `fornax lease: the lease was lost: job ${ID} is gone; the program was stopped`],
    ];
    for (const [error, text] of cases) {
      const s = fakeServer();
      const pids = join(tmp(), 'pids.json');
      const l = lease(s, ['--tree', pids, '--forever']);
      s.set({ state: 'running', started_at: STARTED });
      const { parent, child } = await waitFor(() => readPids(pids), 10_000, 'the program');
      s.failures.push(error);
      // Wakes the long-poll; the next GET meets the error.
      s.set({ note: null });
      expect(await l.run).toBe(123);
      await waitFor(() => !isAlive(parent) && !isAlive(child), 5000, 'the tree to die');
      expect(readFileSync(join(l.dir, 'done'), 'utf8')).toBe(STARTED);
      expect(l.lines.at(-1)).toBe(text);
    }
  });

  test('Ctrl+C while the program runs and it ends in time by itself: the wrapper ends at once, no pause timer holds it open', async () => {
    /** Timers that keep the process alive (unref'd ones are not listed). */
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const s = fakeServer();
    const stop = new AbortController();
    const report = join(tmp(), 'report.json');
    const l = lease(s, ['--report', report, '--sleep', '500', '--exit', '0'], {}, { signal: stop.signal, timings: { interruptMs: 60_000 } });
    s.set({ state: 'running', started_at: STARTED });
    await waitFor(() => readJson(report), 10_000, 'the program');
    stop.abort('SIGINT');
    const at = Date.now();
    expect(await l.run).toBe(130);
    expect(Date.now() - at).toBeLessThan(10_000);
    // A pause of interruptMs left running would keep the wrapper alive for a minute; short timers end meanwhile.
    await waitFor(() => timers() === 0, 3000, 'no timer left');
  });

  test('--rerun: a Ctrl+C while the lease comes back does not start the program again: 130, the job canceled, no done', async () => {
    const s = fakeServer();
    const stop = new AbortController();
    const runs = join(tmp(), 'runs.txt');
    const l = lease(s, ['--runs', runs, '--forever'], { rerun: true }, {
      signal: stop.signal,
      onLine: (line) => {
        if (line.includes('gave the lease back')) stop.abort('SIGINT');
      },
    });
    s.set({ state: 'running', started_at: STARTED });
    await waitFor(() => existsSync(runs), 10_000, 'the first run');
    s.set({ state: 'running', started_at: LATER });
    expect(await l.run).toBe(130);
    expect(readFileSync(runs, 'utf8').split('\n').filter((x) => x.includes(' start '))).toHaveLength(1);
    expect(s.job.state).toBe('canceled');
    expect(existsSync(join(l.dir, 'done'))).toBe(false);
  });

  test('nested: a lease that is not found, or a job that is not a lease: 123, the program never runs', async () => {
    const report = join(tmp(), 'report.json');
    const gone = fakeServer();
    gone.failures.push(new ApiError(404, 'not_found', 'job not found'));
    const a = lease(gone, ['--report', report], {}, { env: NESTED });
    expect(await a.run).toBe(123);
    expect(a.lines).toEqual([`fornax lease: the lease ${ID} this runs in is not found (another client's, or gone)`]);
    const other = fakeServer();
    other.set({ type: 'render', state: 'running', started_at: STARTED });
    const b = lease(other, ['--report', report], {}, { env: NESTED });
    expect(await b.run).toBe(123);
    expect(b.lines).toEqual([`fornax lease: FORNAX_LEASE names job ${ID}, which is not a lease`]);
    expect(existsSync(report)).toBe(false);
  });

  test('nested: Linux: the program stays in the process group of the wrapper, which the outer wrapper ends as a whole', async () => {
    const s = fakeServer();
    s.set({ state: 'running', started_at: STARTED });
    const report = join(tmp(), 'report.json');
    const l = lease(s, ['--report', report, '--sleep', '1000', '--exit', '0'], {}, { env: NESTED });
    const { pid } = await waitFor(() => readJson<{ pid: number }>(report), 10_000, 'the program');
    if (process.platform !== 'win32') expect(processGroupOf(pid)).toBe(processGroupOf(process.pid));
    expect(await l.run).toBe(0);
  });
});
