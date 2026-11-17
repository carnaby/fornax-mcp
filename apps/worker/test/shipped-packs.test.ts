import { describe, expect, test } from 'vitest';
import { loadPack } from '../src/pack.js';
import { shippedExamples, shippedPack } from '../src/shipped.js';
import { expandArgv } from '../src/template.js';

/** A job as run() expands it; POSIX paths and platform 'linux' keep the expected argv exact on both OSes. */
const job = {
  params: {},
  paramsJson: '/w/work/params.json',
  inputs: { audio: '/w/in/audio.m4a', scene: '/w/in/scene.blend' },
  out: '/w/out',
  work: '/w/work',
};

describe('built-in type packs', () => {
  test('transcribe: contract, tools and commands', () => {
    const pack = loadPack(shippedPack('transcribe')!);
    expect(pack.contract).toMatchObject({ name: 'transcribe', version: 1, max_runtime_s: 4 * 3600 });
    expect(Object.keys(pack.contract.inputs)).toEqual(['audio']);
    expect(Object.keys(pack.contract.params.properties).sort()).toEqual(['diarize', 'initial_prompt', 'language', 'model', 'speakers']);
    expect(pack.impl.tools).toEqual(['python', 'ffmpeg']);
    const tools = { python: 'py', ffmpeg: 'ff' };
    expect(expandArgv(pack.impl.run, { pack: '/p', tools, job, platform: 'linux' })).toEqual([
      '/p/env/bin/python', '/p/scripts/run.py', '--params', '/w/work/params.json', '--audio', '/w/in/audio.m4a', '--ffmpeg', 'ff', '--out', '/w/out', '--work', '/w/work',
    ]);
    expect(expandArgv(pack.impl.setup!, { pack: '/p', tools, platform: 'linux' })).toEqual(['py', '/p/scripts/setup.py']);
    expect(expandArgv(pack.impl.check!, { pack: '/p', tools, platform: 'linux' })).toEqual(['/p/env/bin/python', '/p/scripts/check.py', '--ffmpeg', 'ff']);
  });

  test("render: Blender never runs the scene's scripts and is told which file the input is", () => {
    const pack = loadPack(shippedPack('render')!);
    expect(pack.contract).toMatchObject({ name: 'render', version: 1, max_runtime_s: 6 * 3600 });
    expect(pack.contract.params.required).toEqual(['frame_start']);
    expect(pack.impl.tools).toEqual(['blender']);
    expect(pack.impl.setup).toBeUndefined();
    expect(expandArgv(pack.impl.run, { pack: '/p', tools: { blender: 'b' }, job, platform: 'linux' })).toEqual([
      'b', '-b', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
      '--python', '/p/scripts/render.py', '--', '--params', '/w/work/params.json', '--scene', '/w/in/scene.blend', '--out', '/w/out',
    ]);
    expect(expandArgv(pack.impl.check!, { pack: '/p', tools: { blender: 'b' }, platform: 'linux' })).toEqual([
      'b', '-b', '--factory-startup', '--python-exit-code', '1', '--python', '/p/scripts/check.py',
    ]);
  });

  test("lease: no tools, no inputs; it runs on the worker's own Node", () => {
    const pack = loadPack(shippedPack('lease')!);
    expect(pack.contract).toMatchObject({ name: 'lease', version: 1, max_runtime_s: 725 * 60, inputs: {} });
    expect(pack.contract.params.required).toEqual(['minutes']);
    expect(pack.contract.params.properties.minutes).toMatchObject({ type: 'integer', minimum: 1, maximum: 720 });
    expect(pack.contract.params.properties.label).toMatchObject({ type: 'string', maxLength: 80 });
    expect(pack.impl.tools).toEqual([]);
    expect(pack.impl.setup).toBeUndefined();
    expect(expandArgv(pack.impl.run, { pack: '/p', tools: {}, job, node: '/n', platform: 'linux' })).toEqual(['/n', '/p/scripts/lease.mjs', '--params', '/w/work/params.json']);
    expect(expandArgv(pack.impl.check!, { pack: '/p', tools: {}, node: '/n', platform: 'linux' })).toEqual(['/n', '/p/scripts/check.mjs']);
  });

  test('upscale: contract, tools and commands', () => {
    const pack = loadPack(shippedPack('upscale')!);
    expect(pack.contract).toMatchObject({ name: 'upscale', version: 1, max_runtime_s: 3 * 3600, default_priority: 'idle' });
    for (const other of ['lease', 'render', 'transcribe']) expect(loadPack(shippedPack(other)!).contract, other).not.toHaveProperty('default_priority');
    expect(Object.keys(pack.contract.inputs)).toEqual(['video']);
    expect(pack.contract.inputs.video).toMatchObject({ extensions: ['.mp4', '.mov'], max_mb: 1024 });
    expect(Object.keys(pack.contract.params.properties).sort()).toEqual(['audio', 'batch', 'overlap', 'resolution']);
    expect(pack.contract.params.properties.resolution).toMatchObject({ enum: [1080, 1440], default: 1080 });
    expect(pack.contract.params.properties.batch).toMatchObject({ enum: [9, 13, 17, 21, 25, 29] });
    expect(pack.contract.params.properties.batch).not.toHaveProperty('default');
    expect(pack.contract.params.properties.overlap).toMatchObject({ type: 'integer', minimum: 0, maximum: 28, default: 3 });
    expect(pack.contract.params.properties.audio).toMatchObject({ type: 'boolean', default: false });
    expect(pack.contract.description).toMatch(/BT\.601/);
    expect(pack.impl.tools).toEqual(['python', 'ffmpeg', 'ffprobe']);
    const tools = { python: 'py', ffmpeg: 'ff', ffprobe: 'fp' };
    const upscaleJob = { ...job, inputs: { video: '/w/in/video.mp4' } };
    expect(expandArgv(pack.impl.run, { pack: '/p', tools, job: upscaleJob, platform: 'linux' })).toEqual([
      '/p/env/bin/python', '/p/scripts/run.py', '--params', '/w/work/params.json', '--video', '/w/in/video.mp4',
      '--ffmpeg', 'ff', '--ffprobe', 'fp', '--out', '/w/out', '--work', '/w/work',
    ]);
    expect(expandArgv(pack.impl.setup!, { pack: '/p', tools, platform: 'linux' })).toEqual(['py', '/p/scripts/setup.py']);
    expect(expandArgv(pack.impl.check!, { pack: '/p', tools, platform: 'linux' })).toEqual([
      '/p/env/bin/python', '/p/scripts/check.py', '--ffmpeg', 'ff', '--ffprobe', 'fp',
    ]);
  });

  test('the prompt for a new type gets every built-in pack as an example', () => {
    expect(shippedExamples().map((e) => e.name)).toEqual(['lease', 'render', 'transcribe', 'upscale']);
  });
});
