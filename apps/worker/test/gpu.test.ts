import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseNvidiaSmi, readGpu } from '../src/gpu.js';
import { FAKE_SMI } from './helpers.js';

const smi = (mode: string) => [process.execPath, FAKE_SMI, mode];

describe('parseNvidiaSmi', () => {
  test('card 0 counts; every further line is another card', () => {
    expect(parseNvidiaSmi('1130, 16311\n')).toEqual({ used_mib: 1130, total_mib: 16311, cards: 1 });
    expect(parseNvidiaSmi('5120, 16311\r\n800, 8192\r\n')).toEqual({ used_mib: 5120, total_mib: 16311, cards: 2 });
  });

  test('nothing, or anything but two whole numbers per line, is unreadable', () => {
    for (const out of ['', '\n', '[N/A], [N/A]', '1130', '1130, 16311, 3', '1.5, 2', '1130, 16311\nfoo']) expect(parseNvidiaSmi(out), out).toBeNull();
  });
});

describe('readGpu', () => {
  test('one card, two cards', async () => {
    expect(await readGpu({ command: smi('one') })).toEqual({ ok: true, used_mib: 1130, total_mib: 16311, cards: 1 });
    expect(await readGpu({ command: smi('two') })).toEqual({ ok: true, used_mib: 5120, total_mib: 16311, cards: 2 });
  });

  test('every failure is one short reason that starts with nvidia-smi', async () => {
    expect(await readGpu({ command: smi('empty') })).toEqual({ ok: false, error: 'nvidia-smi: unreadable output' });
    expect(await readGpu({ command: smi('text') })).toEqual({ ok: false, error: 'nvidia-smi: unreadable output' });
    expect(await readGpu({ command: smi('fail') })).toEqual({ ok: false, error: 'nvidia-smi: exit code 9' });
    expect(await readGpu({ command: [join(tmpdir(), 'fornax-no-such-dir', 'nvidia-smi')] })).toEqual({ ok: false, error: 'nvidia-smi: not found' });
  });

  test('a hanging nvidia-smi is cut off', async () => {
    const t0 = Date.now();
    expect(await readGpu({ command: smi('hang'), timeoutMs: 500 })).toEqual({ ok: false, error: 'nvidia-smi: no answer within 0.5 s' });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
