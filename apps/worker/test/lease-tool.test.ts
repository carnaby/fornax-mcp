import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import type { Paths } from '../src/paths.js';
import { shippedPack } from '../src/shipped.js';
import { testPaths, useTempDir, waitFor } from './helpers.js';

const tmp = useTempDir();
const ID = '01JLEASETOOL00000000000000';

/** The shipped pack installed into a fresh data directory, where fornax types install puts it. */
function install(): { paths: Paths; pack: string; dir: string } {
  const paths = testPaths(tmp());
  const pack = join(paths.typesDir, 'lease');
  cpSync(shippedPack('lease')!, pack, { recursive: true });
  return { paths, pack, dir: join(paths.leasesDir, ID) };
}

/** lease.mjs as the worker runs it, with a shortened clock: 50 ms ticks, the given grace and minute. */
function tool(pack: string, params: object, o: { graceMs?: number; minuteMs?: number } = {}) {
  const file = join(tmp(), 'params.json');
  writeFileSync(file, JSON.stringify(params));
  const args = [join(pack, 'scripts', 'lease.mjs'), '--params', file, '--tick-ms', '50', '--grace-ms', String(o.graceMs ?? 1000), '--minute-ms', String(o.minuteMs ?? 60_000)];
  const child = spawn(process.execPath, args, { env: { ...process.env, FORNAX_JOB_ID: ID }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out: string[] = [];
  const err: string[] = [];
  child.stdout.on('data', (b: Buffer) => out.push(String(b)));
  child.stderr.on('data', (b: Buffer) => err.push(String(b)));
  let exited = false;
  const code = new Promise<number | null>((resolve) =>
    child.on('close', (c) => {
      exited = true;
      resolve(c);
    }),
  );
  return { code, out, err, running: () => !exited };
}

describe('the lease tool', () => {
  test('done ends it with 0 and removes its folder, <data>/leases/<job id>, the folder fornax lease uses', async () => {
    const { pack, dir } = install();
    const run = tool(pack, { minutes: 5, label: 'blender' });
    await waitFor(() => existsSync(dir), 5000, 'the lease folder');
    writeFileSync(join(dir, 'alive'), 'S1');
    writeFileSync(join(dir, 'done'), 'S1');
    expect(await run.code).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(run.out.join('')).toContain('{"progress":0,"message":"blender, 0 min"}');
  });

  test('a done written before the tool started (a program quicker than the worker) ends it at once', async () => {
    const { pack, dir } = install();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'alive'), 'S1');
    writeFileSync(join(dir, 'done'), 'S1');
    const t0 = Date.now();
    expect(await tool(pack, { minutes: 5 }).code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test('no fornax lease within the grace: exit 4', async () => {
    const { pack } = install();
    const run = tool(pack, { minutes: 5 }, { graceMs: 300 });
    expect(await run.code).toBe(4);
    expect(run.err.join('')).toContain('no `fornax lease` took this lease within 0.3 s');
  });

  test('alive no longer renewed: exit 4', async () => {
    const { pack, dir } = install();
    const run = tool(pack, { minutes: 5 }, { graceMs: 1000 });
    await waitFor(() => existsSync(dir), 5000, 'the lease folder');
    writeFileSync(join(dir, 'alive'), 'S1');
    expect(await run.code).toBe(4);
    expect(run.err.join('')).toContain('`fornax lease` stopped renewing the lease');
  });

  test('an old alive left by an earlier claim gets the full grace from the start', async () => {
    const { pack, dir } = install();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'alive'), 'S1');
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, 'alive'), hourAgo, hourAgo);
    const run = tool(pack, { minutes: 5 }, { graceMs: 1500 });
    // The folder exists before the tool here: its first progress line shows it runs, so the 400 ms count from its start.
    await waitFor(() => run.out.join('').includes('0 min'), 5000, 'the tool to start');
    await sleep(400);
    writeFileSync(join(dir, 'alive'), 'S2');
    writeFileSync(join(dir, 'done'), 'S2');
    expect(await run.code).toBe(0);
  });

  test('a done of an earlier claim does not end this one and stays untouched; the done of this claim ends it', async () => {
    const { pack, dir } = install();
    const run = tool(pack, { minutes: 5 }, { graceMs: 3000 });
    await waitFor(() => existsSync(dir), 5000, 'the lease folder');
    writeFileSync(join(dir, 'alive'), 'S2');
    writeFileSync(join(dir, 'done'), 'S1');
    await sleep(500);
    expect(run.running()).toBe(true);
    expect(readFileSync(join(dir, 'done'), 'utf8')).toBe('S1');
    writeFileSync(join(dir, 'done'), 'S2');
    expect(await run.code).toBe(0);
  });

  test('a done with no alive does not end the lease', async () => {
    const { pack, dir } = install();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'done'), 'S1');
    const run = tool(pack, { minutes: 5 }, { graceMs: 3000 });
    await sleep(500);
    expect(run.running()).toBe(true);
    writeFileSync(join(dir, 'alive'), 'S2');
    writeFileSync(join(dir, 'done'), 'S2');
    expect(await run.code).toBe(0);
  });

  test('minutes ran out: exit 4; progress every minute with the label', async () => {
    const { pack, dir } = install();
    const run = tool(pack, { minutes: 2, label: 'render job' }, { minuteMs: 1000, graceMs: 5000 });
    await waitFor(() => existsSync(dir), 5000, 'the lease folder');
    writeFileSync(join(dir, 'alive'), 'S1');
    expect(await run.code).toBe(4);
    expect(run.err.join('')).toContain('the lease time ran out');
    const progress = run.out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { progress: number; message: string });
    expect(progress).toEqual([
      { progress: 0, message: 'render job, 0 min' },
      { progress: 0.5, message: 'render job, 1 min' },
    ]);
  });

  test('a lease folder that cannot be created: exit 4, never the retried 1', async () => {
    const { pack, paths } = install();
    // <data>/leases as a file: mkdir fails the same way on Windows and Linux.
    writeFileSync(paths.leasesDir, '');
    const run = tool(pack, { minutes: 5 });
    expect(await run.code).toBe(4);
    expect(run.err.join('')).toMatch(/the lease folder cannot be created \(E[A-Z]+\)/);
  });

  test('params that are not an object: exit 4', () => {
    const { pack } = install();
    const file = join(tmp(), 'params.json');
    writeFileSync(file, 'null');
    const r = spawnSync(process.execPath, [join(pack, 'scripts', 'lease.mjs'), '--params', file], { env: { ...process.env, FORNAX_JOB_ID: ID }, encoding: 'utf8' });
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('the params are not an object');
  });

  test('folders untouched for a day are swept at start; younger ones stay', async () => {
    const { pack, paths, dir } = install();
    const old = join(paths.leasesDir, 'OLDJOB');
    const young = join(paths.leasesDir, 'YOUNGJOB');
    mkdirSync(old, { recursive: true });
    mkdirSync(young, { recursive: true });
    const twoDays = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(old, twoDays, twoDays);
    expect(await tool(pack, { minutes: 5 }, { graceMs: 300 }).code).toBe(4);
    expect([existsSync(old), existsSync(young), existsSync(dir)]).toEqual([false, true, false]);
  });

  test('without a job id it ends with 4 at once', () => {
    const { pack } = install();
    const file = join(tmp(), 'params.json');
    writeFileSync(file, JSON.stringify({ minutes: 1 }));
    const env = { ...process.env };
    delete env.FORNAX_JOB_ID;
    const r = spawnSync(process.execPath, [join(pack, 'scripts', 'lease.mjs'), '--params', file], { env, encoding: 'utf8' });
    expect(r.status).toBe(4);
  });

  test('check: the lease folder can be written', () => {
    const { pack, paths } = install();
    const r = spawnSync(process.execPath, [join(pack, 'scripts', 'check.mjs')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(paths.leasesDir)).toBe(true);
  });
});
