import { describe, expect, test } from 'vitest';
import { expandArgv, pythonPath, symbolsOf, TemplateError, wholeSymbol } from '../src/template.js';

const job = {
  params: { samples: 128, title: 'a b; rm -rf ~', frames: [1, 2, 3], hdr: true },
  paramsJson: '/j/work/params.json',
  inputs: { scene: '/j/in/scene.blend' },
  out: '/j/out',
  work: '/j/work',
};
const ctx = { pack: '/p/render', tools: { blender: '/opt/blender/blender' }, job, platform: 'linux' as const };

describe('symbols', () => {
  test('every symbol of an element, in order', () => {
    expect(symbolsOf('--samples={params.samples}x{out}')).toEqual([{ kind: 'params', name: 'samples' }, { kind: 'out' }]);
    expect(symbolsOf('plain')).toEqual([]);
  });

  test('an unknown symbol is an error', () => {
    expect(() => symbolsOf('{params}')).toThrow(TemplateError);
    expect(() => symbolsOf('{nope}')).toThrow(/unknown symbol \{nope\}/);
    expect(() => symbolsOf('{tool.Blender}')).toThrow(TemplateError);
    expect(() => symbolsOf('{}')).toThrow(TemplateError);
  });

  test('whole-element symbols', () => {
    expect(wholeSymbol('{params.frames}')).toEqual({ kind: 'params', name: 'frames' });
    expect(wholeSymbol('-f{params.frames}')).toBeNull();
  });
});

describe('expandArgv', () => {
  test('each element stays exactly one argument, whatever the value holds', () => {
    expect(
      expandArgv(
        ['{tool.blender}', '-b', '{input.scene}', '--title', '{params.title}', '--samples={params.samples}', '--hdr={params.hdr}', '{params_json}', '{out}', '{work}', '{pack}/scripts/render.py'],
        ctx,
      ),
    ).toEqual([
      '/opt/blender/blender', '-b', '/j/in/scene.blend', '--title', 'a b; rm -rf ~', '--samples=128', '--hdr=true',
      '/j/work/params.json', '/j/out', '/j/work', '/p/render/scripts/render.py',
    ]);
  });

  test('a "$" in a value is not a replacement pattern', () => {
    expect(expandArgv(['x={params.title}'], { ...ctx, job: { ...job, params: { title: "$&$'" } } })).toEqual(["x=$&$'"]);
  });

  test('a list as a whole element becomes several arguments; embedded it is an error', () => {
    expect(expandArgv(['--frames', '{params.frames}'], ctx)).toEqual(['--frames', '1', '2', '3']);
    expect(() => expandArgv(['--frames={params.frames}'], ctx)).toThrow(/must be a whole argument/);
  });

  test('an optional input that was not given expands to an empty argument', () => {
    expect(expandArgv(['--mask', '{input.mask}'], ctx)).toEqual(['--mask', '']);
  });

  test('{python} is the venv inside the pack, per platform', () => {
    expect(pythonPath('C:\\fornax\\types\\t', 'win32')).toBe('C:\\fornax\\types\\t\\env\\Scripts\\python.exe');
    expect(pythonPath('/data/types/t', 'linux')).toBe('/data/types/t/env/bin/python');
    expect(expandArgv(['{python}'], ctx)).toEqual(['/p/render/env/bin/python']);
  });

  test('setup and check have no job: job symbols are errors there', () => {
    expect(() => expandArgv(['{out}'], { pack: '/p', tools: {} })).toThrow(/only available in run/);
    expect(expandArgv(['{pack}/x'], { pack: '/p', tools: {} })).toEqual(['/p/x']);
  });

  test('a tool without a path is an error', () => {
    expect(() => expandArgv(['{tool.ffmpeg}'], ctx)).toThrow(/tool ffmpeg has no path/);
  });
});

describe('{node}', () => {
  test('is the Node the worker runs on, or the one the context names', () => {
    expect(symbolsOf('{node}')).toEqual([{ kind: 'node' }]);
    expect(expandArgv(['{node}', '{pack}/scripts/x.mjs'], { pack: '/p/lease', tools: {} })).toEqual([process.execPath, '/p/lease/scripts/x.mjs']);
    expect(expandArgv(['{node}'], { pack: '/p', tools: {}, node: '/opt/node/bin/node' })).toEqual(['/opt/node/bin/node']);
  });
});
