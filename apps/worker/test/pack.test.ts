import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadPack, loadPacks, missingTools, parseDuration } from '../src/pack.js';
import { useTempDir, writeTypeYaml } from './helpers.js';

const tmp = useTempDir();

const base = {
  name: 'render',
  version: 1,
  description: 'Render frames.',
  inputs: { scene: { extensions: ['.blend'], max_mb: 100 } },
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['frame_start'],
    properties: {
      frame_start: { type: 'integer', minimum: 0 },
      samples: { type: 'integer', minimum: 1, default: 128 },
      offset: { type: 'integer', default: 0 },
      seed: { type: 'integer' },
      frames: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 10, default: [] },
    },
  },
  max_runtime: '6h',
  tools: ['blender'],
  check: ['{tool.blender}', '-b', '--python', '{pack}/scripts/check.py'],
  run: ['{tool.blender}', '-b', '--disable-autoexec', '{input.scene}', '--', '--params', '{params_json}', '--out', '{out}', '--samples={params.samples}'],
};

function pack(changes: Record<string, unknown> = {}): string {
  const dir = join(tmp(), 'render');
  writeTypeYaml(dir, { ...base, ...changes });
  return dir;
}
const refused = (changes: Record<string, unknown>, message: RegExp) => expect(() => loadPack(pack(changes))).toThrow(message);

describe('loadPack', () => {
  test('splits the contract from the implementation', () => {
    const p = loadPack(pack());
    expect(p.contract).toMatchObject({ name: 'render', version: 1, max_runtime_s: 21_600, inputs: { scene: { extensions: ['.blend'], max_mb: 100, required: true } } });
    expect(p.contract).not.toHaveProperty('run');
    expect(p.impl).toEqual({ tools: ['blender'], check: base.check, run: base.run });
  });

  test('durations', () => {
    expect([parseDuration('30s'), parseDuration('10m'), parseDuration('6h'), parseDuration('2d')]).toEqual([30, 600, 21_600, 172_800]);
    for (const bad of ['', '0s', '10', '1w', '-1m', '1.5h']) expect(parseDuration(bad), bad).toBeNull();
    refused({ max_runtime: '1w' }, /max_runtime/);
    refused({ max_runtime: '8d' }, /max_runtime_s/);
  });

  test('every symbol must be known', () => {
    refused({ run: ['{tool.blender}', '{nope}'] }, /type pack render: run: unknown symbol \{nope\}/);
    refused({ run: ['{tool.blender}', '{params.missing}'] }, /there is no parameter missing/);
    refused({ run: ['{tool.blender}', '{input.audio}'] }, /there is no input audio/);
    refused({ run: ['{tool.ffmpeg}'] }, /ffmpeg is not listed in tools/);
  });

  test('{node} works in setup, check and run, without any tool', () => {
    const p = loadPack(pack({ tools: [], setup: ['{node}', '{pack}/s.mjs'], check: ['{node}', '{pack}/c.mjs'], run: ['{node}', '{pack}/r.mjs', '{params_json}'] }));
    expect(p.impl).toEqual({ tools: [], setup: ['{node}', '{pack}/s.mjs'], check: ['{node}', '{pack}/c.mjs'], run: ['{node}', '{pack}/r.mjs', '{params_json}'] });
  });

  test('an optional parameter without a default reaches the tool only through {params_json}', () => {
    refused({ run: ['{tool.blender}', '--seed={params.seed}'] }, /only through \{params_json\}/);
  });

  test('a number that may be negative cannot be a whole argument, but may be embedded', () => {
    refused({ run: ['{tool.blender}', '--offset', '{params.offset}'] }, /may be negative/);
    expect(() => loadPack(pack({ run: ['{tool.blender}', '--offset={params.offset}', '{params.frame_start}', '{params.samples}'] }))).not.toThrow();
  });

  test('lists only as whole arguments', () => {
    expect(() => loadPack(pack({ run: ['{tool.blender}', '{params.frames}'] }))).not.toThrow();
    refused({ run: ['{tool.blender}', '--frames={params.frames}'] }, /a list must be a whole argument/);
  });

  test('unbalanced or stray braces are refused in run, check and setup', () => {
    for (const bad of ['{out', 'out}', '{{out}}', '--x={params.samples']) {
      refused({ run: ['{tool.blender}', bad] }, /run: unbalanced brace/);
    }
    refused({ check: ['{tool.blender}', '{pack'] }, /check: unbalanced brace/);
    refused({ setup: ['{python}', 'a}'] }, /setup: unbalanced brace/);
  });

  test('setup and check cannot use job symbols', () => {
    refused({ check: ['{tool.blender}', '{out}'] }, /check: \{out\} is only available in run/);
    refused({ setup: ['{python}', '{params_json}'] }, /setup: \{params_json\} is only available in run/);
  });

  test('strict file: unknown keys, empty run, bad names, device names, dangerous enums', () => {
    refused({ command: 'rm -rf /' }, /command/);
    refused({ run: [] }, /run/);
    refused({ run: ['', 'x'] }, /program/);
    refused({ name: 'Render!' }, /name/);
    refused({ inputs: { con: { extensions: ['.txt'], max_mb: 1 } }, run: ['{tool.blender}', '{input.con}'] }, /reserved on Windows/);
    refused({ params: { type: 'object', additionalProperties: false, properties: { mode: { enum: ['-x'] } } } }, /must not start with/);
  });

  test('a directory without type.yaml', () => {
    const dir = join(tmp(), 'empty');
    mkdirSync(dir);
    expect(() => loadPack(dir)).toThrow(/type pack empty: type.yaml is missing/);
  });
});

describe('loadPacks', () => {
  test('a type.yaml that cannot be read is reported and the other packs still load', () => {
    const root = tmp();
    writeTypeYaml(join(root, 'render'), base);
    mkdirSync(join(root, 'broken', 'type.yaml'), { recursive: true });
    const r = loadPacks(root);
    expect(r.packs.map((p) => p.contract.name)).toEqual(['render']);
    expect(r.errors).toEqual([expect.stringMatching(/^type pack broken: type.yaml cannot be read/)]);
    expect(r.failed).toEqual([{ name: 'broken', reason: expect.stringMatching(/^type.yaml cannot be read/) }]);
  });

  test('loads good packs; reports broken ones and a name that differs from its directory', () => {
    const root = tmp();
    writeTypeYaml(join(root, 'render'), base);
    writeTypeYaml(join(root, 'other'), base);
    writeTypeYaml(join(root, 'bad'), { ...base, name: 'bad', run: [] });
    const r = loadPacks(root);
    expect(r.packs.map((p) => p.contract.name)).toEqual(['render']);
    expect(r.errors).toEqual([expect.stringMatching(/^type pack bad: /), expect.stringMatching(/^type pack other: its name is render/)]);
    expect(r.failed).toEqual([
      { name: 'bad', reason: expect.any(String) },
      { name: 'other', reason: 'its name is render; the directory must have the same name' },
    ]);
    expect(r.failed.map((f) => `type pack ${f.name}: ${f.reason}`)).toEqual(r.errors);
  });

  test('no types directory yet', () => {
    expect(loadPacks(join(tmp(), 'nothing'))).toEqual({ packs: [], errors: [], failed: [] });
  });

  test('missingTools', () => {
    const p = loadPack(pack());
    expect(missingTools(p, {})).toEqual(['blender']);
    expect(missingTools(p, { blender: '/opt/blender/blender' })).toEqual([]);
  });
});
