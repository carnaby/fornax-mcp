import { describe, expect, test } from 'vitest';
import { loadPack } from '../src/pack.js';
import { shippedPack } from '../src/shipped.js';
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
});
