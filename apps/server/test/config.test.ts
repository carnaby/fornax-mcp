import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const env = (extra: Record<string, string> = {}) => {
  dir = mkdtempSync(join(tmpdir(), 'fornax-cfg-'));
  return { FORNAX_DATA: dir, FORNAX_SECRET: 's'.repeat(32), ...extra };
};

describe('loadConfig', () => {
  test('defaults without a config file', () => {
    const c = loadConfig(env());
    expect(c.dbFile).toBe(join(dir, 'fornax.db'));
    expect(c.filesDir).toBe(join(dir, 'files'));
    expect(c.port).toBe(3000);
    expect(c.publicUrl).toBe('http://localhost:3000');
    expect(c.publicUrlConfigured).toBe(false);
    expect(c.limits.maxQueuedPerToken).toBe(50);
    expect(c.retention.finishedMs).toBe(14 * 86_400_000);
    expect(c.retention.orphanUploadMs).toBe(24 * 3_600_000);
    expect(c.webhooks.allowedPrefixes).toEqual([]);
  });

  test('reads fornax.yaml from the data directory', () => {
    const e = env();
    writeFileSync(join(dir, 'fornax.yaml'), 'public_url: https://fornax.example.com\nlimits:\n  max_upload_mb: 10\nretention:\n  finished_days: 2\n');
    const c = loadConfig(e);
    expect(c.publicUrl).toBe('https://fornax.example.com');
    expect(c.publicUrlConfigured).toBe(true);
    expect(c.limits.maxUploadBytes).toBe(10 * 1024 * 1024);
    expect(c.limits.maxOutputBytes).toBe(4096 * 1024 * 1024);
    expect(c.retention.finishedMs).toBe(2 * 86_400_000);
  });

  test('refuses unknown keys, a short secret and a missing explicit config file', () => {
    const e = env();
    writeFileSync(join(dir, 'fornax.yaml'), 'limitz: {}\n');
    expect(() => loadConfig(e)).toThrow(/limitz/);
    expect(() => loadConfig({ ...env(), FORNAX_SECRET: 'short' })).toThrow(/FORNAX_SECRET/);
    expect(() => loadConfig(env({ FORNAX_CONFIG: join(dir, 'nope.yaml') }))).toThrow(/nope.yaml/);
  });

  test('webhook prefixes must be http(s) URLs ending with a slash', () => {
    const write = (prefix: string) => {
      const e = env();
      writeFileSync(join(dir, 'fornax.yaml'), `webhooks:
  allowed_prefixes:
    - ${prefix}
`);
      return e;
    };
    expect(() => loadConfig(write('https://app.example.com/hooks'))).toThrow(/end with/);
    expect(() => loadConfig(write('ftp://app.example.com/hooks/'))).toThrow(/http/);
    expect(loadConfig(write('https://app.example.com/hooks/')).webhooks.allowedPrefixes).toEqual(['https://app.example.com/hooks/']);
  });
});
