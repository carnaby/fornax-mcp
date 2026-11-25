import { expect, test } from 'vitest';
import { announceBody, completeBody, LEASE_MS, outputsJson, releaseBody, statusBody } from '../src/wire.js';

test('outputs.json: meta and preview per output, nothing else', () => {
  const ok = { 'a.png': { meta: { width: 2, hdr: true, note: null }, preview: 'p/a.jpg' } };
  expect(outputsJson.parse(ok)).toEqual(ok);
  expect(outputsJson.safeParse({ 'a.png': { size: 1 } }).success).toBe(false);
  expect(outputsJson.safeParse({ 'a.png': { meta: { nested: { x: 1 } } } }).success).toBe(false);
});

test('the complete body reuses it and defaults to no outputs', () => {
  expect(completeBody.parse({ lease: 'l' })).toEqual({ lease: 'l', outputs: {} });
});

test('the lease length is shared by server and worker, and a release says why', () => {
  expect(LEASE_MS).toBe(600_000);
  expect(releaseBody.parse({ lease: 'l' })).toEqual({ lease: 'l', reason: 'stopping' });
  expect(releaseBody.parse({ lease: 'l', reason: 'environment' }).reason).toBe('environment');
  expect(releaseBody.safeParse({ lease: 'l', reason: 'tired' }).success).toBe(false);
});

test('a worker status says why it waits, or null', () => {
  const busy = { reason: 'gpu_busy', used_mib: 5120, total_mib: 16311, limit_mib: 2048 };
  expect(statusBody.parse({ waiting: null })).toEqual({ waiting: null });
  expect(statusBody.parse({ waiting: busy })).toEqual({ waiting: busy });
  const unreadable = { reason: 'gpu_unreadable', error: 'nvidia-smi: not found', limit_mib: 2048 };
  expect(statusBody.parse({ waiting: unreadable })).toEqual({ waiting: unreadable });
  expect(statusBody.safeParse({}).success).toBe(false);
  expect(statusBody.safeParse({ waiting: { ...busy, used_mib: 1.5 } }).success).toBe(false);
  expect(statusBody.safeParse({ waiting: { ...busy, extra: 1 } }).success).toBe(false);
  expect(statusBody.safeParse({ waiting: { ...unreadable, error: 'x'.repeat(201) } }).success).toBe(false);
  expect(statusBody.safeParse({ waiting: { reason: 'tired', limit_mib: 1 } }).success).toBe(false);
});

import { describe } from 'vitest';
import { heartbeatReply, priorityBody, requeueBody } from '../src/wire.js';

describe('spec 07 wire shapes', () => {
  test('heartbeat reply: requeued defaults to false', () => {
    expect(heartbeatReply.parse({ lease_until: null, cancel: true })).toEqual({ lease_until: null, cancel: true, requeued: false });
    expect(heartbeatReply.parse({ lease_until: null, cancel: true, requeued: true }).requeued).toBe(true);
  });

  test('priority body: low becomes normal; extra keys are refused', () => {
    expect(priorityBody.parse({ priority: 'low' })).toEqual({ priority: 'normal' });
    expect(priorityBody.safeParse({ priority: 'idle', now: true }).success).toBe(false);
  });

  test('requeue body: idle defaults to false', () => {
    expect(requeueBody.parse({})).toEqual({ idle: false });
    expect(requeueBody.parse({ idle: true })).toEqual({ idle: true });
  });
});

test('an announcement may carry one environment line per type (spec 12 § 3.1)', () => {
  expect(announceBody.parse({ types: [] })).toEqual({ types: [] });
  const line = 'Blender 5.2.2 LTS, Cycles on OPTIX (Fake GPU)';
  expect(announceBody.parse({ types: [], environments: { render: line } }).environments).toEqual({ render: line });
  const ok = (environments: unknown) => announceBody.safeParse({ types: [], environments }).success;
  expect(ok({ render: 'x'.repeat(400) })).toBe(true);
  expect(ok({ render: '' })).toBe(false);
  expect(ok({ render: 'x'.repeat(401) })).toBe(false);
  expect(ok({ render: `two${String.fromCharCode(10)}lines` })).toBe(false);
  expect(ok({ render: `bell${String.fromCharCode(0x85)}` })).toBe(false);
  expect(ok({ render: `del${String.fromCharCode(0x7f)}` })).toBe(false);
  expect(ok({ Render: 'x' })).toBe(false);
  expect(ok({ render: 5 })).toBe(false);
});
