import { expect, test } from 'vitest';
import { sign, verify } from '../src/http/signing.js';

const secret = 'k'.repeat(32);
const now = new Date('2026-11-13T10:00:00Z');
const inAnHour = new Date(now.getTime() + 3_600_000);

test('round trip', () => {
  expect(verify(secret, sign(secret, 'abc', inAnHour), now)).toBe('abc');
});

test('tampered, expired, other secret and garbage are refused', () => {
  const s = sign(secret, 'abc', inAnHour);
  expect(verify(secret, s.replace('abc', 'abd'), now)).toBeNull();
  expect(verify(secret, s, new Date(inAnHour.getTime() + 1000))).toBeNull();
  expect(verify('x'.repeat(32), s, now)).toBeNull();
  expect(verify(secret, 'a.b', now)).toBeNull();
  expect(verify(secret, '', now)).toBeNull();
});

test('payload with a dot is refused at signing', () => {
  expect(() => sign(secret, 'a.b', inAnHour)).toThrow();
});
