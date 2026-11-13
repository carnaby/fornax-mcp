import { describe, expect, test } from 'vitest';
import { fingerprint, generateToken, parseToken, tokenHash, webhookKey } from '../src/tokens.js';

describe('tokens', () => {
  test('generated token has the documented format and parses back', () => {
    const t = generateToken('majo');
    expect(t).toMatch(/^fornax-majo-[A-Za-z0-9_-]{43}$/);
    expect(parseToken(t)).toEqual({ name: 'majo' });
  });

  test('two tokens differ', () => {
    expect(generateToken('a')).not.toBe(generateToken('a'));
  });

  test('invalid names are refused', () => {
    for (const bad of ['', 'Majo', 'a-b', 'x'.repeat(25)]) expect(() => generateToken(bad)).toThrow();
  });

  test('parseToken refuses anything else', () => {
    const body = 'A'.repeat(43);
    expect(parseToken(`fornax-majo-${body}`)).toEqual({ name: 'majo' });
    for (const bad of [`fornax-majo-${body}x`, `fornax-majo-${'A'.repeat(42)}`, `tabula-majo-${body}`, `fornax-Majo-${body}`, `fornax--${body}`]) {
      expect(parseToken(bad)).toBeNull();
    }
  });

  test('hash is sha256 hex and deterministic', () => {
    const t = generateToken('pc');
    expect(tokenHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(t)).toBe(tokenHash(t));
  });

  test('fingerprint is two groups of base32 and depends on the token', () => {
    const a = generateToken('pc');
    const b = generateToken('pc');
    expect(fingerprint(a)).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(fingerprint(a)).toBe(fingerprint(a));
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  test('webhook key is 32 bytes, deterministic, not the token hash', () => {
    const t = generateToken('pc');
    expect(webhookKey(t)).toHaveLength(32);
    expect(webhookKey(t).equals(webhookKey(t))).toBe(true);
    expect(webhookKey(t).toString('hex')).not.toBe(tokenHash(t));
  });
});
