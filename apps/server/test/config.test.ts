import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CONFIG_VARIABLES, defaultTrayFile, defaultWorkerZip, loadConfig } from '../src/config.js';

const MB = 1024 * 1024;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const base = { FORNAX_SECRET: 's'.repeat(32) };
const env = (extra: Record<string, string> = {}) => ({ ...base, ...extra });

describe('loadConfig', () => {
  test('defaults', () => {
    const c = loadConfig(env());
    expect(c.dataDir).toBe('/data');
    expect(c.dbFile).toBe(join('/data', 'fornax.db'));
    expect(c.filesDir).toBe(join('/data', 'files'));
    expect(c.port).toBe(3000);
    expect(c.host).toBe('0.0.0.0');
    expect(c.trustProxy).toBe(0);
    expect(c.publicUrl).toBe('http://localhost:3000');
    expect(c.publicUrlConfigured).toBe(false);
    expect(c.limits).toEqual({ maxUploadBytes: 4096 * MB, maxOutputBytes: 4096 * MB, maxQueuedPerToken: 50 });
    expect(c.retention).toEqual({ finishedMs: 14 * DAY, orphanUploadMs: 24 * HOUR, unavailableTypeMs: 7 * DAY, pendingTokenMs: 7 * DAY });
    expect(c.webhooks.allowedPrefixes).toEqual([]);
    expect(c.workerZip).toBe(defaultWorkerZip());
    expect(c.trayMsi).toBe(defaultTrayFile('msi'));
    expect(c.trayDeb).toBe(defaultTrayFile('deb'));
  });

  test('reads every variable', () => {
    const c = loadConfig(
      env({
        PUBLIC_URL: 'https://fornax.example.com',
        DATA_DIR: '/var/lib/fornax-test',
        PORT: '8080',
        HOST: '127.0.0.1',
        TRUST_PROXY: '1',
        FORNAX_MAX_UPLOAD_MB: '10',
        FORNAX_MAX_OUTPUT_MB: '20',
        FORNAX_MAX_QUEUED_PER_TOKEN: '5',
        FORNAX_FINISHED_DAYS: '2',
        FORNAX_ORPHAN_UPLOAD_HOURS: '0.5',
        FORNAX_UNAVAILABLE_TYPE_DAYS: '3',
        FORNAX_PENDING_TOKEN_DAYS: '1',
        FORNAX_WEBHOOK_PREFIXES: 'https://app.example.com/hooks/, https://other.example.com/',
        FORNAX_WORKER_ZIP: '/opt/fornax-worker.zip',
        FORNAX_TRAY_MSI: '/opt/fornax-tray.msi',
        FORNAX_TRAY_DEB: '/opt/fornax-tray.deb',
      }),
    );
    expect(c.publicUrl).toBe('https://fornax.example.com');
    expect(c.publicUrlConfigured).toBe(true);
    expect(c.dbFile).toBe(join('/var/lib/fornax-test', 'fornax.db'));
    expect([c.port, c.host, c.trustProxy]).toEqual([8080, '127.0.0.1', 1]);
    expect(c.limits).toEqual({ maxUploadBytes: 10 * MB, maxOutputBytes: 20 * MB, maxQueuedPerToken: 5 });
    expect(c.retention).toEqual({ finishedMs: 2 * DAY, orphanUploadMs: HOUR / 2, unavailableTypeMs: 3 * DAY, pendingTokenMs: DAY });
    expect(c.webhooks.allowedPrefixes).toEqual(['https://app.example.com/hooks/', 'https://other.example.com/']);
    expect(c.workerZip).toBe('/opt/fornax-worker.zip');
    expect([c.trayMsi, c.trayDeb]).toEqual(['/opt/fornax-tray.msi', '/opt/fornax-tray.deb']);
  });

  test('PUBLIC_URL keeps the origin only; an empty value counts as unset', () => {
    expect(loadConfig(env({ PUBLIC_URL: 'https://fornax.example.com/' })).publicUrl).toBe('https://fornax.example.com');
    expect(loadConfig(env({ PUBLIC_URL: 'HTTPS://Fornax.Example.com:8443' })).publicUrl).toBe('https://fornax.example.com:8443');
    expect(loadConfig(env({ PUBLIC_URL: '  ' })).publicUrlConfigured).toBe(false);
  });

  test('refuses a PUBLIC_URL with a path, query, fragment, credentials or another scheme', () => {
    for (const bad of [
      'https://fornax.example.com/fornax',
      'https://fornax.example.com/?a=1',
      'https://fornax.example.com/#x',
      'https://user:pass@fornax.example.com',
      'ftp://fornax.example.com',
      'fornax.example.com',
    ]) {
      expect(() => loadConfig(env({ PUBLIC_URL: bad })), bad).toThrow(/PUBLIC_URL/);
    }
  });

  test('names the variable of a malformed number', () => {
    const cases: [string, string][] = [
      ['PORT', 'abc'],
      ['PORT', '0'],
      ['PORT', '70000'],
      ['TRUST_PROXY', '-1'],
      ['TRUST_PROXY', '11'],
      ['FORNAX_MAX_UPLOAD_MB', '4GB'],
      ['FORNAX_MAX_UPLOAD_MB', '0'],
      ['FORNAX_MAX_QUEUED_PER_TOKEN', '1.5'],
      ['FORNAX_FINISHED_DAYS', 'two'],
      ['FORNAX_FINISHED_DAYS', '0'],
      ['FORNAX_PENDING_TOKEN_DAYS', '-1'],
    ];
    for (const [name, value] of cases) expect(() => loadConfig(env({ [name]: value })), `${name}=${value}`).toThrow(new RegExp(name));
  });

  test('a retention of 0 is refused: it would delete everything within a minute', () => {
    for (const name of ['FORNAX_FINISHED_DAYS', 'FORNAX_ORPHAN_UPLOAD_HOURS', 'FORNAX_UNAVAILABLE_TYPE_DAYS', 'FORNAX_PENDING_TOKEN_DAYS']) {
      for (const value of ['0', '0.0']) {
        expect(() => loadConfig(env({ [name]: value })), `${name}=${value}`).toThrow(`${name} must be a number greater than 0, not "${value}"`);
      }
    }
    expect(loadConfig(env({ FORNAX_ORPHAN_UPLOAD_HOURS: '0.5' })).retention.orphanUploadMs).toBe(1_800_000);
  });

  test('a missing or short secret stops the server without echoing it', () => {
    expect(() => loadConfig({})).toThrow(/FORNAX_SECRET/);
    let message = '';
    try {
      loadConfig({ FORNAX_SECRET: 'short-secret-value' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/FORNAX_SECRET/);
    expect(message).not.toContain('short-secret-value');
  });

  test('webhook prefixes must be http(s) URLs ending with a slash', () => {
    expect(() => loadConfig(env({ FORNAX_WEBHOOK_PREFIXES: 'https://app.example.com/hooks' }))).toThrow(/FORNAX_WEBHOOK_PREFIXES.*end with/);
    expect(() => loadConfig(env({ FORNAX_WEBHOOK_PREFIXES: 'ftp://app.example.com/hooks/' }))).toThrow(/FORNAX_WEBHOOK_PREFIXES.*http/);
    expect(loadConfig(env({ FORNAX_WEBHOOK_PREFIXES: ' , ' })).webhooks.allowedPrefixes).toEqual([]);
  });

  test('.env.example lists exactly the variables the server reads, with values it accepts', () => {
    const text = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const entries = text
      .split('\n')
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const);
    expect(entries.map(([k]) => k)).toEqual([...CONFIG_VARIABLES]);
    expect(() => loadConfig(Object.fromEntries(entries))).not.toThrow();
  });
});
