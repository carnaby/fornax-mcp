import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import type { GpuReading } from '../src/gpu.js';
import { type LoopApi, runWorker, type TypeState } from '../src/loop.js';
import { NODE_TOOLS, testPaths, useTempDir, waitFor, writeEchoPack } from './helpers.js';

const tmp = useTempDir();
const free: GpuReading = { ok: true, used_mib: 1130, total_mib: 16311, cards: 1 };
const busy: GpuReading = { ok: true, used_mib: 5120, total_mib: 16311, cards: 1 };
const gone: GpuReading = { ok: false, error: 'nvidia-smi: exit code 4' };
const WAIT = 'waiting for the card';

/**
 * A worker against a stand-in for the server, with two packs: "echo", whose check adds one character to a file for
 * every run, and "sick", whose check fails. `card()` is the reading of the card at each measurement.
 */
function start(card: () => GpuReading, opts: { gpu?: boolean; brokenPack?: boolean } = {}) {
  const root = tmp();
  const paths = testPaths(root);
  const counter = join(root, 'checks.txt');
  writeEchoPack(paths.typesDir, { check: ['{tool.node}', '-e', "require('node:fs').appendFileSync(process.argv[1], 'x')", counter] });
  writeEchoPack(paths.typesDir, { name: 'sick', check: ['{tool.node}', '-e', 'process.exit(3)'] });
  // A pack that cannot be loaded: its type.yaml is a directory.
  if (opts.brokenPack) mkdirSync(join(paths.typesDir, 'broken', 'type.yaml'), { recursive: true });
  const announced: string[][] = [];
  const types: TypeState[][] = [];
  const lines: string[] = [];
  const api = {
    announce: async (contracts: { name: string }[]) => {
      const names = contracts.map((c) => c.name);
      announced.push(names);
      return names;
    },
    claim: async () => {
      await sleep(20);
      return null;
    },
    status: async () => {},
  } as unknown as LoopApi;
  const stop = new AbortController();
  const done = runWorker({
    api, paths, tools: NODE_TOOLS, out: (l) => lines.push(l), signal: stop.signal, claimWaitS: 0,
    onTypes: (t) => types.push(t),
    ...(opts.gpu === false ? {} : { gpu: { maxUsedMib: 2048, measure: async () => card(), pollMs: 20, resendMs: 1000 } }),
  });
  return {
    paths, announced, types, lines,
    checks: () => (existsSync(counter) ? readFileSync(counter, 'utf8').length : 0),
    stop: async () => {
      stop.abort();
      return done;
    },
  };
}

describe('the types and the card (spec 06c 2)', () => {
  test('while the card cannot be read the types are neither checked nor announced; all wait for it', async () => {
    // A pack that cannot be loaded is unavailable even without the card, under its directory's name.
    const w = start(() => gone, { brokenPack: true });
    await waitFor(() => w.types.length >= 1, 5000, 'a types report');
    await sleep(150);
    expect(await w.stop()).toBe(0);
    expect(w.checks()).toBe(0);
    expect(w.announced).toEqual([]);
    expect(w.types).toEqual([
      [
        { name: 'broken', state: 'unavailable', reason: expect.stringMatching(/^type.yaml cannot be read/) },
        { name: 'echo', state: 'waiting', reason: WAIT },
        { name: 'sick', state: 'waiting', reason: WAIT },
      ],
    ]);
    expect(w.lines.filter((l) => l.startsWith('waiting for the card'))).toEqual(['waiting for the card before checking the types (nvidia-smi: exit code 4)']);
    expect(w.lines).toContain('waiting: the card cannot be read (nvidia-smi: exit code 4), limit 2048 MiB; no job is taken');
  });

  test('once the card can be read the types are checked once and announced', async () => {
    let card: GpuReading = gone;
    const w = start(() => card);
    await waitFor(() => w.types.length >= 1, 5000, 'the waiting types');
    card = free;
    await waitFor(() => w.announced.length >= 1, 10_000, 'the announcement');
    await sleep(200);
    await w.stop();
    expect(w.checks()).toBe(1);
    expect(w.announced).toEqual([['echo']]);
    expect(w.types).toHaveLength(2);
    expect(w.types[1]).toEqual([
      { name: 'echo', state: 'offered' },
      { name: 'sick', state: 'unavailable', reason: 'check failed (exit code 3)' },
    ]);
  });

  test('a card that goes and comes back: the offered types wait, then are checked again', async () => {
    let card: GpuReading = free;
    const w = start(() => card);
    await waitFor(() => w.announced.length >= 1, 10_000, 'the first announcement');
    card = gone;
    await waitFor(() => w.types.at(-1)?.[0]?.state === 'waiting', 5000, 'the types waiting');
    expect(w.types.at(-1)).toEqual([
      { name: 'echo', state: 'waiting', reason: WAIT },
      { name: 'sick', state: 'unavailable', reason: 'check failed (exit code 3)' },
    ]);
    await sleep(150);
    expect(w.checks()).toBe(1);
    card = free;
    await waitFor(() => w.announced.length >= 2, 10_000, 'the second announcement');
    await w.stop();
    expect(w.checks()).toBe(2);
    expect(w.types.at(-1)?.[0]).toEqual({ name: 'echo', state: 'offered' });
    // The start line is said only at the start.
    expect(w.lines.some((l) => l.startsWith('waiting for the card before checking the types'))).toBe(false);
  });

  test('a new pack while the card is gone is checked only once the card is back', async () => {
    let card: GpuReading = free;
    const w = start(() => card);
    await waitFor(() => w.announced.length >= 1, 10_000, 'the first announcement');
    card = gone;
    await waitFor(() => w.types.at(-1)?.[0]?.state === 'waiting', 5000, 'the types waiting');
    writeEchoPack(w.paths.typesDir, { name: 'late' });
    await sleep(200);
    expect(w.announced).toHaveLength(1);
    card = free;
    await waitFor(() => w.announced.length >= 2, 10_000, 'the second announcement');
    await w.stop();
    expect(w.announced[1]).toEqual(['echo', 'late']);
  });

  test('a card over the limit at the start: it is there, so the types are checked', async () => {
    const w = start(() => busy);
    await waitFor(() => w.announced.length >= 1, 10_000, 'the announcement');
    await w.stop();
    expect(w.checks()).toBe(1);
    expect(w.types.at(-1)?.[0]).toEqual({ name: 'echo', state: 'offered' });
  });

  test('without the card check the types are checked at once and reported', async () => {
    const w = start(() => gone, { gpu: false });
    await waitFor(() => w.types.length >= 1, 10_000, 'a types report');
    await w.stop();
    expect(w.checks()).toBe(1);
    expect(w.types[0]).toEqual([
      { name: 'echo', state: 'offered' },
      { name: 'sick', state: 'unavailable', reason: 'check failed (exit code 3)' },
    ]);
  });

  test('a stop while waiting for the card ends the worker without checking anything', async () => {
    const w = start(() => gone);
    await waitFor(() => w.types.length >= 1, 5000, 'the waiting types');
    const before = Date.now();
    expect(await w.stop()).toBe(0);
    expect(Date.now() - before).toBeLessThan(2000);
    expect(w.checks()).toBe(0);
    expect(w.announced).toEqual([]);
  });

  test('reasons are one line of at most 300 characters', async () => {
    const root = tmp();
    const paths = testPaths(root);
    writeEchoPack(paths.typesDir, { name: 'loud', check: ['{tool.node}', '-e', "console.log('a'.repeat(400)); console.log('b'.repeat(400)); process.exit(3)"] });
    const types: TypeState[][] = [];
    const stop = new AbortController();
    const api = {
      announce: async () => [],
      claim: async () => {
        await sleep(20);
        return null;
      },
      status: async () => {},
    } as unknown as LoopApi;
    const done = runWorker({ api, paths, tools: NODE_TOOLS, out: () => {}, signal: stop.signal, claimWaitS: 0, onTypes: (t) => types.push(t) });
    await waitFor(() => types.length >= 1, 10_000, 'a types report');
    stop.abort();
    await done;
    const reason = types[0]?.[0]?.reason ?? '';
    expect(reason.startsWith('check failed (exit code 3): ')).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason).not.toMatch(/[\r\n]/);
  });
});
