import { expect, test } from 'vitest';
import { completeBody, LEASE_MS, outputsJson, releaseBody, statusBody } from '../src/wire.js';

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
