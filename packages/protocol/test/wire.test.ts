import { expect, test } from 'vitest';
import { completeBody, outputsJson } from '../src/wire.js';

test('outputs.json: meta and preview per output, nothing else', () => {
  const ok = { 'a.png': { meta: { width: 2, hdr: true, note: null }, preview: 'p/a.jpg' } };
  expect(outputsJson.parse(ok)).toEqual(ok);
  expect(outputsJson.safeParse({ 'a.png': { size: 1 } }).success).toBe(false);
  expect(outputsJson.safeParse({ 'a.png': { meta: { nested: { x: 1 } } } }).success).toBe(false);
});

test('the complete body reuses it and defaults to no outputs', () => {
  expect(completeBody.parse({ lease: 'l' })).toEqual({ lease: 'l', outputs: {} });
});
