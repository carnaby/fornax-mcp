import { expect, test } from 'vitest';
import { sign, verify } from '../src/http/signing.js';

const secret = 'k'.repeat(32);
const now = new Date('2026-11-13T10:00:00Z');
const inAnHour = new Date(now.getTime() + 3_600_000);

test('round trip', () => {
  expect(verify(secret, 'upload', sign(secret, 'upload', 'abc', inAnHour), now)).toBe('abc');
});

test('tampered, expired, other secret and garbage are refused', () => {
  const s = sign(secret, 'upload', 'abc', inAnHour);
  expect(verify(secret, 'upload', s.replace('abc', 'abd'), now)).toBeNull();
  expect(verify(secret, 'upload', s, new Date(inAnHour.getTime() + 1000))).toBeNull();
  expect(verify('x'.repeat(32), 'upload', s, now)).toBeNull();
  expect(verify(secret, 'upload', 'a.b', now)).toBeNull();
  expect(verify(secret, 'upload', '', now)).toBeNull();
});

test('a signature made for one purpose fails for another', () => {
  const s = sign(secret, 'upload', 'abc', inAnHour);
  expect(verify(secret, 'download', s, now)).toBeNull();
  expect(verify(secret, 'upload', s, now)).toBe('abc');
});

test('a purpose that is not [a-z]+ is refused', () => {
  expect(() => sign(secret, 'a:b', 'abc', inAnHour)).toThrow();
});

test('payload with a dot is refused at signing', () => {
  expect(() => sign(secret, 'upload', 'a.b', inAnHour)).toThrow();
});
