import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { clipboardCommands, copyToClipboard } from '../src/clipboard.js';
import { buildTypePrompt } from '../src/prompt.js';
import { readShippedDoc, shippedExamples, shippedPack, shippedTypesDir } from '../src/shipped.js';
import { useTempDir } from './helpers.js';

const tmp = useTempDir();

describe('new type prompt', () => {
  test('holds the pack directory, system, GPU, format, examples, rules and steps', () => {
    const packDir = join('data', 'types', 'upscale');
    const text = buildTypePrompt({
      name: 'upscale', packDir, system: 'linux 6.8 (x64)', gpu: 'Example GPU, 24576 MiB',
      formatDoc: '# Format\nrules here', examples: [{ name: 'render', yaml: 'name: render\n' }],
    });
    for (const part of [
      '"upscale"', packDir, 'linux 6.8 (x64)', 'Example GPU, 24576 MiB', 'rules here', '### render/type.yaml', 'name: render',
      '--disable-autoexec', '{input.<name>}', join(packDir, 'env'), 'First ask me', '`fornax doctor upscale`',
    ]) {
      expect(text, part).toContain(part);
    }
  });
});

describe('clipboard', () => {
  test('clip.exe on Windows; wl-copy, then xclip on Linux; null when none works', () => {
    expect(clipboardCommands('win32')).toEqual([['clip.exe', []]]);
    expect(clipboardCommands('linux')).toEqual([['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]);
    const tried: string[] = [];
    expect(copyToClipboard('hi', 'linux', (cmd) => (tried.push(cmd), cmd === 'xclip'))).toBe('xclip');
    expect(tried).toEqual(['wl-copy', 'xclip']);
    expect(copyToClipboard('hi', 'linux', () => false)).toBeNull();
  });

  test('Windows gets UTF-16LE with a byte order mark, so non-ASCII paths survive', () => {
    let seen: Buffer | undefined;
    copyToClipboard('é', 'win32', (_cmd, _args, input) => ((seen = input), true));
    expect(seen).toEqual(Buffer.from('\ufeffé', 'utf16le'));
  });
});

describe('shipped files', () => {
  test('the types directory is found by its README.md, walking up', () => {
    const root = tmp();
    mkdirSync(join(root, 'types', 'render'), { recursive: true });
    writeFileSync(join(root, 'types', 'README.md'), '# Fornax type packs');
    writeFileSync(join(root, 'types', 'render', 'type.yaml'), 'name: render\n');
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    expect(shippedTypesDir(deep)).toBe(join(root, 'types'));
    expect(shippedPack('render', deep)).toBe(join(root, 'types', 'render'));
    expect(shippedPack('transcribe', deep)).toBeNull();
    expect(shippedExamples(deep)).toEqual([{ name: 'render', yaml: 'name: render\n' }]);
    expect(readShippedDoc(deep)).toBe('# Fornax type packs');
  });

  test('in this repository the format doc is found from the worker sources', () => {
    expect(readShippedDoc()).toMatch(/^# Fornax type packs/);
  });
});
