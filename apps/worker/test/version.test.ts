import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { WORKER_VERSION } from '../src/version.js';

test('WORKER_VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  expect(WORKER_VERSION).toBe(pkg.version);
});
