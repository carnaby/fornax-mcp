import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import { ApiError, LeaseLostError, NetworkError } from '../src/api.js';
import { sweepJobs } from '../src/instance.js';
import { loadPack } from '../src/pack.js';
import { jobDirs } from '../src/paths.js';
import { HEARTBEAT_MS, inputFileName, type JobDeps, runJob } from '../src/run-job.js';
import { fakeApi, fakeClaim, isAlive, jobsLeft, NODE_TOOLS, readPids, testPaths, useTempDir, waitFor, writeEchoPack } from './helpers.js';

const tmp = useTempDir();

function setup(packOpts: Parameters<typeof writeEchoPack>[1] = {}) {
  const paths = testPaths(tmp());
  const pack = loadPack(writeEchoPack(paths.typesDir, packOpts));
  const deps = (api: JobDeps['api'], extra: Partial<JobDeps> = {}): JobDeps => ({
    api, paths, tools: NODE_TOOLS, heartbeatMs: 100, killGraceMs: 500, retryDelaysMs: [10, 10, 10], ...extra,
  });
  return { paths, pack, deps };
}

test('a running job beats every 5 s, so a cancel stops it within seconds', () => {
  expect(HEARTBEAT_MS).toBe(5000);
});

test('input files are named by the worker, never by the client', () => {
  expect(inputFileName('scene', 'my scene.BLEND')).toBe('scene.blend');
  expect(inputFileName('audio', '../../x.mp3')).toBe('audio.mp3');
  expect(inputFileName('audio', 'noext')).toBe('audio');
  expect(inputFileName('audio', 'a.tar.gz')).toBe('audio.gz');
  expect(inputFileName('audio', 'x.m p3')).toBe('audio');
  expect(inputFileName('audio', `x.${'a'.repeat(11)}`)).toBe('audio');
});

describe('runJob', () => {
  test('exit 0: input in, outputs and log up, complete with outputs.json, job directory gone', async () => {
    const { paths, pack, deps } = setup();
    const f = fakeApi();
    const job = fakeClaim({ params: { mode: 'ok' }, inputs: [{ name: 'source', file_name: '../../Evil Name.TXT', size: 5, sha256: 'x' }] });
    const r = await runJob(job, pack, deps(f.api));
    expect(r).toEqual({ outcome: 'succeeded', detail: '2 output(s)' });
    expect(f.calls[0]).toEqual({ method: 'heartbeat', args: [job.id, job.lease, 0, null, expect.any(AbortSignal)] });
    expect(f.called('downloadInput')[0]!.args[3]).toBe(join(jobDirs(paths, job.id, job.lease).in, 'source.txt'));
    expect(Object.fromEntries(f.uploads)).toEqual({ 'result.txt': 'HELLO', 'previews/result.jpg': 'JPEG', 'log.txt': expect.stringContaining('working') });
    expect(f.called('uploadOutput').map((c) => c.args[3])).toEqual(['output', 'output', 'log']);
    expect(f.called('complete')[0]!.args[2]).toEqual({ 'result.txt': { meta: { chars: 5 }, preview: 'previews/result.jpg' } });
    expect(jobsLeft(paths)).toEqual([]);
  });

  test('progress from the tool reaches the heartbeat', async () => {
    const { pack, deps } = setup();
    const f = fakeApi();
    await runJob(fakeClaim({ params: { mode: 'slow', ms: 400 } }), pack, deps(f.api));
    expect(f.called('heartbeat').some((c) => c.args[2] === 0.1 && c.args[3] === 'slow start')).toBe(true);
  });

  test('exit 2 fails for good with the last log line; the log is uploaded', async () => {
    const { pack, deps } = setup();
    const f = fakeApi();
    expect((await runJob(fakeClaim({ params: { mode: 'exit', code: 2 } }), pack, deps(f.api))).outcome).toBe('failed');
    expect(f.called('fail')[0]!.args.slice(2)).toEqual(['the tool refused the input (exit code 2): bad input: the file is empty', true]);
    expect(f.uploads.get('log.txt')).toContain('bad input');
  });

  test('exit 4 fails for good: the tool asked not to be retried; the log is uploaded', async () => {
    const { pack, deps } = setup();
    const f = fakeApi();
    expect((await runJob(fakeClaim({ params: { mode: 'exit', code: 4 } }), pack, deps(f.api))).outcome).toBe('failed');
    expect(f.called('fail')[0]!.args.slice(2)).toEqual(['the tool failed and asked not to be retried (exit code 4): bad input: the file is empty', true]);
    expect(f.uploads.get('log.txt')).toContain('bad input');
  });

  test('exit 1 and any other code fail for a retry', async () => {
    const { pack, deps } = setup();
    for (const code of [1, 7]) {
      const f = fakeApi();
      expect((await runJob(fakeClaim({ params: { mode: 'exit', code } }), pack, deps(f.api))).outcome).toBe('retry');
      expect(f.called('fail')[0]!.args[3]).toBe(false);
    }
  });

  test('exit 3 releases the job and reports the type broken', async () => {
    const { pack, deps } = setup();
    const f = fakeApi();
    expect((await runJob(fakeClaim({ params: { mode: 'exit', code: 3 } }), pack, deps(f.api))).outcome).toBe('broken');
    expect(f.called('release')).toHaveLength(1);
    expect(f.called('release')[0]!.args[2]).toBe('environment');
    expect(f.called('fail')).toHaveLength(0);
  });

  test('a tool that cannot be started is a broken environment, like exit 3', async () => {
    const { pack, deps } = setup();
    const f = fakeApi();
    const r = await runJob(fakeClaim({ params: { mode: 'ok' } }), pack, deps(f.api, { tools: { node: join(tmp(), 'no-such-node.exe') } }));
    expect(r.outcome).toBe('broken');
    expect(r.detail).toMatch(/^could not start /);
    expect(f.called('release')).toHaveLength(1);
    expect(f.called('fail')).toHaveLength(0);
  });

  test("params are checked against this worker's contract", async () => {
    const { pack, deps } = setup();
    const f = fakeApi();
    expect((await runJob(fakeClaim({ params: { mode: 'nope' } }), pack, deps(f.api))).outcome).toBe('failed');
    expect(f.called('fail')[0]!.args[2]).toMatch(/^params do not match this type's current version/);
    expect(f.called('fail')[0]!.args[3]).toBe(true);
  });

  test('a cancel seen in a heartbeat stops the whole tree', async () => {
    const { paths, pack, deps } = setup();
    const pidFile = join(tmp(), 'pids.json');
    let beats = 0;
    const f = fakeApi({ heartbeat: async () => ({ cancel: ++beats > 1 && readPids(pidFile) !== null }) });
    const job = fakeClaim({ params: { mode: 'hang', pid_file: pidFile } });
    expect((await runJob(job, pack, deps(f.api))).outcome).toBe('canceled');
    const pids = readPids(pidFile)!;
    await waitFor(() => !isAlive(pids.parent) && !isAlive(pids.child), 5000, 'the tree to die');
    expect(f.called('fail')).toHaveLength(0);
    expect(jobsLeft(paths)).toEqual([]);
  });

  test('a lost lease (409) stops the tool and drops the job', async () => {
    const { paths, pack, deps } = setup();
    const pidFile = join(tmp(), 'pids.json');
    let beats = 0;
    const f = fakeApi({
      heartbeat: async () => {
        if (++beats > 1 && readPids(pidFile)) throw new LeaseLostError(409, 'conflict', 'the job is no longer yours');
        return { cancel: false };
      },
    });
    const job = fakeClaim({ params: { mode: 'hang', pid_file: pidFile } });
    expect((await runJob(job, pack, deps(f.api))).outcome).toBe('lost');
    expect(f.called('fail')).toHaveLength(0);
    expect(f.called('complete')).toHaveLength(0);
    expect(jobsLeft(paths)).toEqual([]);
  });

  test('max_runtime: the tool is stopped and the job fails for a retry', async () => {
    const { pack, deps } = setup({ maxRuntime: '1s' });
    const f = fakeApi();
    const r = await runJob(fakeClaim({ params: { mode: 'hang', pid_file: join(tmp(), 'p.json') } }), pack, deps(f.api));
    expect(r.outcome).toBe('retry');
    expect(f.called('fail')[0]!.args[2]).toMatch(/max_runtime \(1 s\)/);
  });

  test('Ctrl+C while the tool runs: the tree is stopped and the job released', async () => {
    const { pack, deps } = setup();
    const pidFile = join(tmp(), 'pids.json');
    const stop = new AbortController();
    const f = fakeApi({
      heartbeat: async () => {
        if (readPids(pidFile)) stop.abort();
        return { cancel: false };
      },
    });
    const r = await runJob(fakeClaim({ params: { mode: 'hang', pid_file: pidFile } }), pack, deps(f.api, { signal: stop.signal }));
    expect(r.outcome).toBe('released');
    const pids = readPids(pidFile)!;
    await waitFor(() => !isAlive(pids.parent) && !isAlive(pids.child), 5000, 'the tree to die');
    expect(f.called('release')).toHaveLength(1);
    expect(f.called('release')[0]!.args[2]).toBe('stopping');
    expect(f.called('fail')).toHaveLength(0);
  });

  test("the tool gets FORNAX_JOB_ID, FORNAX_OUT and FORNAX_WORK, never the worker's own FORNAX_* variables", async () => {
    const { pack, deps } = setup();
    const f = fakeApi();
    process.env.FORNAX_TEST_SECRET = 'do not pass';
    try {
      await runJob(fakeClaim({ params: { mode: 'env' } }), pack, deps(f.api));
    } finally {
      delete process.env.FORNAX_TEST_SECRET;
    }
    expect(JSON.parse(f.uploads.get('env.json')!)).toEqual(['FORNAX_JOB_ID', 'FORNAX_OUT', 'FORNAX_WORK']);
  });

  test('anything collectOutputs throws (here outputs.json is a directory) fails the job for good', async () => {
    const { pack, deps } = setup();
    const f = fakeApi();
    const r = await runJob(fakeClaim({ params: { mode: 'json-dir' } }), pack, deps(f.api));
    expect(r.outcome).toBe('failed');
    expect(f.called('fail')).toHaveLength(1);
    // readFile's EISDIR carries no path; the error code stands in, never a message with this PC's paths.
    expect(f.called('fail')[0]!.args[2]).toBe('out/ could not be read (EISDIR)');
    expect(f.called('fail')[0]!.args[3]).toBe(true);
    expect([...f.uploads.keys()]).toEqual(['log.txt']);
    expect(f.called('complete')).toHaveLength(0);
  });

  test('an output that changes after it was collected fails the job for good, naming it', async () => {
    const { paths, pack, deps } = setup();
    const job = fakeClaim({ params: { mode: 'ok' } });
    const f = fakeApi({
      uploadOutput: async (_id, _lease, name) => {
        // A detached grandchild writes on while the first output (previews/result.jpg) is uploaded.
        if (name === 'previews/result.jpg') appendFileSync(join(jobDirs(paths, job.id, job.lease).out, 'result.txt'), ' MORE');
      },
    });
    const r = await runJob(job, pack, deps(f.api));
    expect(r.outcome).toBe('failed');
    expect(f.called('fail')[0]!.args[2]).toMatch(/^out\/result\.txt changed after the tool ended/);
    expect(f.called('fail')[0]!.args[3]).toBe(true);
    expect(f.called('uploadOutput').map((c) => c.args[2])).toEqual(['previews/result.jpg', 'log.txt']);
    expect(f.called('complete')).toHaveLength(0);
  });

  test('an output swapped for a link after it was collected is never uploaded', async (ctx) => {
    const { paths, pack, deps } = setup();
    const job = fakeClaim({ params: { mode: 'ok' } });
    const secret = join(tmp(), 'secret.txt');
    // As long as the real result ("NO INPUT"), so only the link check can catch it.
    writeFileSync(secret, 'SECRET!!');
    let linked = true;
    const f = fakeApi({
      uploadOutput: async (_id, _lease, name) => {
        if (name !== 'previews/result.jpg') return;
        const result = join(jobDirs(paths, job.id, job.lease).out, 'result.txt');
        rmSync(result);
        try {
          symlinkSync(secret, result, 'file');
        } catch {
          // Windows without the privilege to create file symlinks.
          linked = false;
          writeFileSync(result, 'NO INPUT');
        }
      },
    });
    const r = await runJob(job, pack, deps(f.api));
    if (!linked) ctx.skip();
    expect(r.outcome).toBe('failed');
    expect(f.called('fail')[0]!.args[2]).toMatch(/^out\/result\.txt changed after the tool ended/);
    expect(f.called('uploadOutput').map((c) => c.args[2])).toEqual(['previews/result.jpg', 'log.txt']);
  });

  test('a network outage mid-job: failed heartbeats and uploads are retried and the job still completes', async () => {
    const { pack, deps } = setup();
    let beats = 0;
    let uploadTries = 0;
    const server = fakeApi();
    const f = fakeApi({
      heartbeat: async () => {
        beats++;
        if (beats >= 2 && beats <= 4) throw new NetworkError('cannot reach the server: ECONNREFUSED');
        return { cancel: false };
      },
      uploadOutput: async (...args) => {
        if (++uploadTries === 1) throw new NetworkError('cannot reach the server: ECONNRESET');
        return server.api.uploadOutput(...args);
      },
    });
    const lines: string[] = [];
    const r = await runJob(fakeClaim({ params: { mode: 'slow', ms: 600 } }), pack, deps(f.api, { log: (l) => lines.push(l) }));
    expect(r.outcome).toBe('succeeded');
    expect(beats).toBeGreaterThanOrEqual(5);
    expect(lines.some((l) => l.startsWith('heartbeat failed'))).toBe(true);
    expect([...server.uploads.keys()].sort()).toEqual(['log.txt', 'previews/result.jpg', 'result.txt']);
    expect(f.called('complete')).toHaveLength(1);
  });

  test('failed heartbeats are told once per outage, and again when they get through', async () => {
    const { pack, deps } = setup();
    let beats = 0;
    // Two outages: beats 2-4 and 7-8 fail (beat 1 is the claim's confirmation, outside the timer).
    const f = fakeApi({
      heartbeat: async () => {
        beats++;
        if ((beats >= 2 && beats <= 4) || (beats >= 7 && beats <= 8)) throw new NetworkError('cannot reach the server: ECONNREFUSED');
        return { cancel: false };
      },
    });
    const lines: string[] = [];
    const r = await runJob(fakeClaim({ params: { mode: 'slow', ms: 1500 } }), pack, deps(f.api, { log: (l) => lines.push(l) }));
    expect(r.outcome).toBe('succeeded');
    expect(beats).toBeGreaterThanOrEqual(9);
    expect(lines.filter((l) => l.startsWith('heartbeat failed'))).toHaveLength(2);
    expect(lines.filter((l) => l === 'heartbeats get through again')).toHaveLength(2);
  });

  test('Ctrl+C during an upload: the upload is abandoned and the job released, never completed', async () => {
    const { paths, pack, deps } = setup();
    const stop = new AbortController();
    const f = fakeApi({
      uploadOutput: (_id, _lease, _name, _kind, _file, signal) =>
        new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new DOMException('the operation was aborted', 'AbortError'));
          signal?.addEventListener('abort', abort, { once: true });
          stop.abort();
        }),
    });
    const job = fakeClaim({ params: { mode: 'ok' } });
    const r = await runJob(job, pack, deps(f.api, { signal: stop.signal }));
    expect(r.outcome).toBe('released');
    expect(f.called('release')).toHaveLength(1);
    expect(f.called('complete')).toHaveLength(0);
    expect(f.called('fail')).toHaveLength(0);
    expect(jobsLeft(paths)).toEqual([]);
  });

  test('the lease is kept alive while outputs are uploaded: heartbeats go on with progress 1', async () => {
    const { pack, deps } = setup();
    let uploading = false;
    const during: unknown[][] = [];
    const f = fakeApi({
      heartbeat: async (...args) => {
        if (uploading) during.push(args);
        return { cancel: false };
      },
      uploadOutput: async (_id, _lease, name) => {
        if (name !== 'result.txt') return;
        uploading = true;
        await sleep(500);
        uploading = false;
      },
    });
    const r = await runJob(fakeClaim({ params: { mode: 'ok' } }), pack, deps(f.api));
    expect(r.outcome).toBe('succeeded');
    expect(during.length).toBeGreaterThanOrEqual(2);
    expect(during.every((a) => a[2] === 1 && a[3] === 'uploading outputs')).toBe(true);
    expect(f.called('complete')).toHaveLength(1);
  });

  test('a cancel seen during an upload aborts it and ends the job as canceled', async () => {
    const { paths, pack, deps } = setup();
    let uploading = false;
    let aborted = false;
    const f = fakeApi({
      heartbeat: async () => ({ cancel: uploading }),
      uploadOutput: (_id, _lease, _name, _kind, _file, signal) =>
        new Promise<void>((_resolve, reject) => {
          uploading = true;
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('the operation was aborted', 'AbortError'));
          }, { once: true });
        }),
    });
    const job = fakeClaim({ params: { mode: 'ok' } });
    const r = await runJob(job, pack, deps(f.api));
    expect(r.outcome).toBe('canceled');
    expect(aborted).toBe(true);
    expect(f.called('complete')).toHaveLength(0);
    expect(f.called('fail')).toHaveLength(0);
    expect(f.called('release')).toHaveLength(0);
    expect(jobsLeft(paths)).toEqual([]);
  });

  test('a lost lease seen during an upload aborts it and drops the job', async () => {
    const { pack, deps } = setup();
    let uploading = false;
    const f = fakeApi({
      heartbeat: async () => {
        if (uploading) throw new LeaseLostError(409, 'conflict', 'the job is no longer yours');
        return { cancel: false };
      },
      uploadOutput: (_id, _lease, _name, _kind, _file, signal) =>
        new Promise<void>((_resolve, reject) => {
          uploading = true;
          signal?.addEventListener('abort', () => reject(new DOMException('the operation was aborted', 'AbortError')), { once: true });
        }),
    });
    expect((await runJob(fakeClaim({ params: { mode: 'ok' } }), pack, deps(f.api))).outcome).toBe('lost');
    expect(f.called('complete')).toHaveLength(0);
    expect(f.called('fail')).toHaveLength(0);
  });

  test('a heartbeat that hangs is cut off by its timeout; the next ones go on', async () => {
    const { pack, deps } = setup();
    let beats = 0;
    const f = fakeApi({
      heartbeat: (_id, _lease, _progress, _message, signal) => {
        // The second heartbeat never gets an answer (a half-open connection).
        if (++beats !== 2) return Promise.resolve({ cancel: false });
        return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    });
    const lines: string[] = [];
    const r = await runJob(fakeClaim({ params: { mode: 'slow', ms: 800 } }), pack, deps(f.api, { heartbeatTimeoutMs: 150, log: (l) => lines.push(l) }));
    expect(r.outcome).toBe('succeeded');
    expect(lines.some((l) => l.startsWith('heartbeat failed'))).toBe(true);
    expect(beats).toBeGreaterThanOrEqual(4);
  });

  test('a leftover directory of an earlier attempt that cannot be removed does not block the next attempt', async () => {
    const { paths, pack, deps } = setup();
    const f = fakeApi();
    const lines: string[] = [];
    // A process left from an earlier attempt holds a file (Windows): no existing job directory can be removed.
    const held = async (dir: string) => {
      if (existsSync(dir)) throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir somewhere'), { code: 'EBUSY' });
    };
    const first = await runJob(fakeClaim({ lease: 'lease-1', attempt: 1, params: { mode: 'exit', code: 1 } }), pack, deps(f.api, { removeDir: held, log: (l) => lines.push(l) }));
    expect(first.outcome).toBe('retry');
    expect(lines).toContain('the job directory could not be removed (EBUSY)');
    expect(readdirSync(paths.jobsDir)).toHaveLength(1);
    // The next claim of the same job (a new lease), on the same worker: it runs and completes.
    const second = await runJob(fakeClaim({ lease: 'lease-2', attempt: 2, params: { mode: 'ok' } }), pack, deps(f.api, { removeDir: held }));
    expect(second).toEqual({ outcome: 'succeeded', detail: '2 output(s)' });
    expect(f.called('release')).toHaveLength(0);
    expect(f.called('complete')).toHaveLength(1);
    // The next worker start sweeps the leftovers.
    expect(await sweepJobs(paths)).toEqual({ failed: 0, code: null });
    expect(readdirSync(paths.jobsDir)).toEqual([]);
  });

  test('a job directory that cannot be created gives the job back; it never fails it', async () => {
    const { paths, pack, deps } = setup();
    // A file where <data>/jobs should be: no job directory can be made.
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(paths.jobsDir, 'not a directory');
    const f = fakeApi();
    const r = await runJob(fakeClaim({ params: { mode: 'ok' } }), pack, deps(f.api));
    expect(r.outcome).toBe('released');
    expect(r.detail).toMatch(/^the job directory could not be created \([A-Z]+\)$/);
    expect(f.called('release')).toHaveLength(1);
    expect(f.called('fail')).toHaveLength(0);
    expect(f.called('complete')).toHaveLength(0);
    expect(readFileSync(paths.jobsDir, 'utf8')).toBe('not a directory');
  });

  test('an output the server refuses (413) fails the job for good after one try, naming it', async () => {
    const { pack, deps } = setup();
    const f = fakeApi({
      uploadOutput: async (_id, _lease, name) => {
        if (name === 'result.txt') throw new ApiError(413, 'too_large', 'the outputs of this job exceed the limit');
      },
    });
    const r = await runJob(fakeClaim({ params: { mode: 'ok' } }), pack, deps(f.api));
    expect(r.outcome).toBe('failed');
    expect(f.called('fail')[0]!.args.slice(2)).toEqual(['out/result.txt was refused by the server: the outputs of this job exceed the limit', true]);
    expect(f.called('uploadOutput').filter((c) => c.args[2] === 'result.txt')).toHaveLength(1);
    expect(f.called('complete')).toHaveLength(0);
  });

  test('complete refused by the server (400, 422) fails the job for good after one try', async () => {
    const { pack, deps } = setup();
    for (const status of [400, 422]) {
      const f = fakeApi({
        complete: async () => {
          throw new ApiError(status, 'invalid', 'outputs.json names an unknown output');
        },
      });
      const r = await runJob(fakeClaim({ params: { mode: 'ok' } }), pack, deps(f.api));
      expect(r.outcome).toBe('failed');
      expect(f.called('complete')).toHaveLength(1);
      expect(f.called('fail')[0]!.args.slice(2)).toEqual(['the server refused the outputs: outputs.json names an unknown output', true]);
    }
  });

  test('a server restart longer than the retry delays but shorter than the lease: heartbeats go on and the job completes', async () => {
    const { pack, deps } = setup();
    const server = fakeApi();
    let downUntil = 0;
    let beatsWhileDown = 0;
    const down = () => Date.now() < downUntil;
    const refused = () => new NetworkError('cannot reach the server: ECONNREFUSED');
    const f = fakeApi({
      heartbeat: async () => {
        if (down()) {
          beatsWhileDown++;
          throw refused();
        }
        return { cancel: false };
      },
      uploadOutput: async (...args) => {
        // The server goes away for 800 ms when the first output is sent, far longer than the retry delays (2 x 10 ms).
        if (downUntil === 0) downUntil = Date.now() + 800;
        if (down()) throw refused();
        return server.api.uploadOutput(...args);
      },
    });
    const r = await runJob(fakeClaim({ params: { mode: 'ok' } }), pack, deps(f.api, { retryDelaysMs: [10, 10], leaseMs: 3000, leaseMarginMs: 500 }));
    expect(r.outcome).toBe('succeeded');
    expect(beatsWhileDown).toBeGreaterThanOrEqual(2);
    expect([...server.uploads.keys()].sort()).toEqual(['log.txt', 'previews/result.jpg', 'result.txt']);
  });

  test('complete is retried through an outage shorter than the lease', async () => {
    const { pack, deps } = setup();
    let downUntil = 0;
    const f = fakeApi({
      complete: async () => {
        if (downUntil === 0) downUntil = Date.now() + 800;
        if (Date.now() < downUntil) throw new NetworkError('cannot reach the server: ECONNREFUSED');
      },
    });
    const r = await runJob(fakeClaim({ params: { mode: 'ok' } }), pack, deps(f.api, { retryDelaysMs: [10, 10], leaseMs: 3000, leaseMarginMs: 500 }));
    expect(r.outcome).toBe('succeeded');
    expect(f.called('complete').length).toBeGreaterThan(3);
  });

  test('retries end once the lease would have run out', async () => {
    const { pack, deps } = setup();
    const f = fakeApi({
      complete: async () => {
        throw new NetworkError('cannot reach the server: ECONNREFUSED');
      },
      fail: async () => {
        throw new NetworkError('cannot reach the server: ECONNREFUSED');
      },
    });
    const started = Date.now();
    const r = await runJob(fakeClaim({ params: { mode: 'ok' } }), pack, deps(f.api, { retryDelaysMs: [10, 10], leaseMs: 600, leaseMarginMs: 100 }));
    expect(r.outcome).toBe('lost');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('no retry pause may run past the lease margin: the bound counts the pause before it starts', async () => {
    const { pack, deps } = setup();
    let lastBeat = Date.now();
    const tries: number[] = [];
    const f = fakeApi({
      heartbeat: async () => {
        lastBeat = Date.now();
        return { cancel: false };
      },
      complete: async () => {
        tries.push(Date.now() - lastBeat);
        throw new NetworkError('cannot reach the server: ECONNREFUSED');
      },
    });
    // Usable lease: 1500 ms after the last heartbeat. Pauses of 600 ms: tries at about 0, 600 and 1200 ms; one more
    // pause would end at 1800 ms, past the bound, so it must not start.
    const r = await runJob(fakeClaim({ params: { mode: 'ok' } }), pack, deps(f.api, { retryDelaysMs: [600], leaseMs: 2000, leaseMarginMs: 500 }));
    expect(r.outcome).toBe('retry');
    expect(tries.length).toBeGreaterThanOrEqual(2);
    for (const t of tries) expect(t).toBeLessThan(1500);
  });

  test('a tool ended by the same Ctrl+C as the worker: the job is released, not failed', async () => {
    const { pack, deps } = setup();
    const pidFile = join(tmp(), 'pid.json');
    const stop = new AbortController();
    const f = fakeApi();
    const running = runJob(fakeClaim({ params: { mode: 'interrupted', pid_file: pidFile } }), pack, deps(f.api, { signal: stop.signal }));
    // The worker's own signal arrives a moment after the tool is gone.
    const { parent } = await waitFor(() => readPids(pidFile), 10_000, 'the tool to start');
    while (isAlive(parent)) await sleep(5);
    await sleep(20);
    stop.abort();
    const r = await running;
    expect(r.outcome).toBe('released');
    expect(f.called('fail')).toHaveLength(0);
    expect(f.called('release')).toHaveLength(1);
  });

  test('a local error reaches the server without any path of this PC', async () => {
    const { paths, pack, deps } = setup();
    const f = fakeApi({
      // A local file-system error whose message names an absolute path.
      downloadInput: async (_id, _lease, _input, dest) => writeFileSync(join(dest, 'missing', 'x'), 'x'),
    });
    const r = await runJob(fakeClaim({ params: { mode: 'ok' }, inputs: [{ name: 'source', file_name: 'a.txt', size: 5, sha256: 'x' }] }), pack, deps(f.api));
    expect(r.outcome).toBe('retry');
    const error = f.called('fail')[0]!.args[2] as string;
    expect(error).toBe('worker error: ENOENT');
    expect(error).not.toContain(paths.dataDir);
    expect(error).not.toMatch(/[A-Za-z]:[\\/]|\/tmp\//);
  });
});
