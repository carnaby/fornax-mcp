import { setTimeout as sleep } from 'node:timers/promises';
import type { WorkerWaiting } from '@fornax/protocol';
import { describe, expect, test } from 'vitest';
import { ApiError, NetworkError } from '../src/api.js';
import type { GpuReading } from '../src/gpu.js';
import { type LoopApi, runWorker } from '../src/loop.js';
import { testPaths, useTempDir, waitFor } from './helpers.js';

const tmp = useTempDir();
const busy: GpuReading = { ok: true, used_mib: 5120, total_mib: 16311, cards: 1 };
const free: GpuReading = { ok: true, used_mib: 1130, total_mib: 16311, cards: 1 };

/** A worker against a recording stand-in for the server; `readings` are measured in turn, the last one repeats. */
function start(
  readings: GpuReading[],
  status: (w: WorkerWaiting | null) => Promise<void> = async () => {},
  { resendMs = 100 }: { resendMs?: number } = {},
) {
  const events: string[] = [];
  const sent: (WorkerWaiting | null)[] = [];
  const lines: string[] = [];
  const api = {
    announce: async () => [],
    claim: async () => {
      events.push('claim');
      await sleep(20);
      return null;
    },
    status: async (w: WorkerWaiting | null) => {
      events.push(w === null ? 'status null' : `status ${w.reason}`);
      sent.push(w);
      await status(w);
    },
  } as unknown as LoopApi;
  let i = 0;
  const stop = new AbortController();
  const done = runWorker({
    api, paths: testPaths(tmp()), tools: {}, out: (l) => lines.push(l), signal: stop.signal, claimWaitS: 0,
    gpu: { maxUsedMib: 2048, measure: async () => readings[Math.min(i++, readings.length - 1)]!, pollMs: 20, resendMs },
  });
  return {
    events, sent, lines,
    stop: async () => {
      stop.abort();
      return done;
    },
  };
}

describe('the card check before a claim', () => {
  test('over the limit nothing is claimed and the server is told why; one console line per change', async () => {
    const w = start([busy]);
    await waitFor(() => w.sent.length >= 1, 5000, 'a status');
    await sleep(60);
    expect(await w.stop()).toBe(0);
    expect(w.events).not.toContain('claim');
    expect(w.sent[0]).toEqual({ reason: 'gpu_busy', used_mib: 5120, total_mib: 16311, limit_mib: 2048 });
    expect(w.lines.filter((l) => l.startsWith('waiting:'))).toEqual([
      'waiting: 5120 MiB of 16311 MiB of the card in use by other programs, limit 2048 MiB; no job is taken',
    ]);
  });

  test('under the limit again: waiting null first, then the claim', async () => {
    // A long resend period: a slow machine must not add a second "status gpu_busy" between the two busy readings.
    const w = start([busy, busy, free], undefined, { resendMs: 1000 });
    await waitFor(() => w.events.includes('claim'), 5000, 'a claim');
    await w.stop();
    expect(w.events.slice(0, w.events.indexOf('claim') + 1)).toEqual(['status gpu_busy', 'status null', 'claim']);
    expect(w.lines).toContain('the card is free again (1130 of 16311 MiB in use, limit 2048 MiB); taking jobs');
  });

  test('a card free from the start needs no status at all', async () => {
    const w = start([free]);
    await waitFor(() => w.events.includes('claim'), 5000, 'a claim');
    await w.stop();
    expect(w.sent).toEqual([]);
  });

  test('a card that cannot be read is waited for like a busy one, with the reason', async () => {
    const w = start([{ ok: false, error: 'nvidia-smi: not found' }]);
    await waitFor(() => w.sent.length >= 1, 5000, 'a status');
    await w.stop();
    expect(w.events).not.toContain('claim');
    expect(w.sent[0]).toEqual({ reason: 'gpu_unreadable', error: 'nvidia-smi: not found', limit_mib: 2048 });
    expect(w.lines).toContain('waiting: the card cannot be read (nvidia-smi: not found), limit 2048 MiB; no job is taken');
  });

  test('while waiting, the status goes out again every resend period (it keeps the worker online)', async () => {
    const w = start([busy]);
    await waitFor(() => w.sent.length >= 3, 5000, 'three statuses');
    await w.stop();
    expect(w.lines.filter((l) => l.startsWith('waiting:'))).toHaveLength(1);
  });

  test('an older server without the status route: one line, no more tries, the card is still checked', async () => {
    const w = start([busy], async () => {
      throw new ApiError(404, 'not_found', 'not found');
    });
    await waitFor(() => w.lines.some((l) => l.includes('does not take the worker status')), 5000, 'the line');
    await sleep(250);
    await w.stop();
    expect(w.sent).toHaveLength(1);
    expect(w.events).not.toContain('claim');
  });

  test('an unreachable server is told again on the next pass', async () => {
    let fails = 1;
    const w = start([busy], async () => {
      if (fails-- > 0) throw new NetworkError('cannot reach the server: ECONNREFUSED');
    });
    await waitFor(() => w.sent.length >= 2, 5000, 'a second status');
    expect(await w.stop()).toBe(0);
  });
});
