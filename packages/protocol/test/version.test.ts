import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { FORNAX_VERSION } from '../src/index.js';

test('FORNAX_VERSION is the version of every package', () => {
  for (const path of ['../../../package.json', '../package.json', '../../../apps/server/package.json', '../../../apps/worker/package.json']) {
    const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version?: string };
    expect(pkg.version, path).toBe(FORNAX_VERSION);
  }
});

test('the tray has the same version in all its files', () => {
  const tray = (path: string) => readFileSync(new URL(`../../../apps/tray/${path}`, import.meta.url), 'utf8');
  expect((JSON.parse(tray('package.json')) as { version: string }).version).toBe(FORNAX_VERSION);
  expect((JSON.parse(tray('src-tauri/tauri.conf.json')) as { version: string }).version).toBe(FORNAX_VERSION);
  expect(/^version = "([^"]+)"/m.exec(tray('src-tauri/Cargo.toml'))?.[1]).toBe(FORNAX_VERSION);
  expect(/name = "fornax-tray"\nversion = "([^"]+)"/.exec(tray('src-tauri/Cargo.lock'))?.[1]).toBe(FORNAX_VERSION);
});
