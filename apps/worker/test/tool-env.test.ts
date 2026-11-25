import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { writeSecret } from '../src/secrets.js';
import { loadPack } from '../src/pack.js';
import { hiddenNames, packEnv, setupEnv, toolEnv } from '../src/tool-env.js';
import { useTempDir, writeEchoPack } from './helpers.js';

const tmp = useTempDir();
const dirsIn = (root: string) => ({ secretsDir: join(root, 'secrets'), typesDir: join(root, 'types') });

test('hidden: stored secrets, secrets any loadable pack asks for, and the extra names, upper case (spec 08 § 4.2)', () => {
  const dirs = dirsIn(tmp());
  expect([...hiddenNames(dirs)]).toEqual([]);
  writeSecret(dirs.secretsDir, 'EXAMPLE_TOKEN', 'hf_test_value_123');
  writeEchoPack(dirs.typesDir, { name: 'wants', setup: ['{tool.node}', '-e', '0'], secrets: ['OTHER_TOKEN'] });
  // A broken pack counts for nothing.
  mkdirSync(join(dirs.typesDir, 'broken'), { recursive: true });
  writeFileSync(join(dirs.typesDir, 'broken', 'type.yaml'), 'secrets: [THIRD_TOKEN]\n');
  expect([...hiddenNames(dirs, ['Also_Token'])].sort()).toEqual(['ALSO_TOKEN', 'EXAMPLE_TOKEN', 'OTHER_TOKEN']);
});

test('a secret stored after the worker started counts at the next process', () => {
  const dirs = dirsIn(tmp());
  process.env.EXAMPLE_TOKEN = 'inherited';
  try {
    expect(toolEnv(dirs).EXAMPLE_TOKEN).toBe('inherited');
    writeSecret(dirs.secretsDir, 'EXAMPLE_TOKEN', 'hf_test_value_123');
    expect(toolEnv(dirs)).not.toHaveProperty('EXAMPLE_TOKEN');
    expect(toolEnv(dirs, { FORNAX_JOB_ID: 'J1' }).FORNAX_JOB_ID).toBe('J1');
  } finally {
    delete process.env.EXAMPLE_TOKEN;
  }
});

test('every process of a pack gets its Python cache folder; it is no secret (spec 12 § 5.8)', () => {
  const dirs = dirsIn(tmp());
  const dir = writeEchoPack(dirs.typesDir, { name: 'wants', setup: ['{tool.node}', '-e', '0'], secrets: ['OTHER_TOKEN'] });
  writeSecret(dirs.secretsDir, 'OTHER_TOKEN', 'hf_test_value_123');
  expect(packEnv(dir)).toEqual({ PYTHONPYCACHEPREFIX: join(dir, 'env', 'pycache') });
  const prepared = setupEnv(dirs, loadPack(dir), dir);
  expect(prepared.env.PYTHONPYCACHEPREFIX).toBe(join(dir, 'env', 'pycache'));
  expect(prepared.values).toEqual(['hf_test_value_123']);
});
