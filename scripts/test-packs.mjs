#!/usr/bin/env node
// Runs the Python unit tests of the built-in type packs (types/*/tests). They use the standard library only and need no
// GPU, models or network. Without Python 3.10+ this fails under CI and only warns elsewhere.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
const probe = ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'];
const python = candidates.find((c) => spawnSync(c, probe, { stdio: 'ignore' }).status === 0);
if (!python) {
  const message = 'no Python 3.10 or newer (python3 or python) was found: the type pack tests did not run';
  if (process.env.CI) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}
let failed = false;
for (const name of readdirSync(join(root, 'types')).sort()) {
  const tests = join(root, 'types', name, 'tests');
  if (!existsSync(tests)) continue;
  console.log(`types/${name}`);
  // -B: no __pycache__ in the repository.
  const r = spawnSync(python, ['-B', '-m', 'unittest', 'discover', '-s', tests, '-t', tests], { stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
