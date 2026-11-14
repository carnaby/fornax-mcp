import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { FORNAX_VERSION } from '../src/index.js';

test('FORNAX_VERSION is the version of every package', () => {
  for (const path of ['../../../package.json', '../package.json', '../../../apps/server/package.json', '../../../apps/worker/package.json']) {
    const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version?: string };
    expect(pkg.version, path).toBe(FORNAX_VERSION);
  }
});
