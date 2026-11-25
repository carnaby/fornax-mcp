import { describe, expect, test } from 'vitest';
import { textWindow } from '../src/files/text-window.js';

/** Every part of `whole` read with windows of `max` bytes, as get_output's next_offset chain does. */
function parts(whole: Buffer, max: number): string[] {
  const out: string[] = [];
  let at: number | null = 0;
  while (at !== null) {
    const w = textWindow(whole.subarray(at, Math.min(at + max, whole.length)), at, whole.length);
    out.push(w.text);
    at = w.nextOffset;
  }
  return out;
}

describe('textWindow (spec 14 § 6.1)', () => {
  test('parts join to the whole file, also through multi-byte characters', () => {
    const whole = Buffer.from(`${'ľščťžýáíé'.repeat(500)}\nkoniec`, 'utf8');
    for (const max of [1000, 1001, 1002, 1003]) {
      const got = parts(whole, max);
      expect(got.join(''), String(max)).toBe(whole.toString('utf8'));
      expect(got.some((p) => p.includes(String.fromCharCode(0xfffd))), String(max)).toBe(false);
    }
  });

  test('a window ends after the last line break in its last quarter', () => {
    const whole = Buffer.from(`${'a'.repeat(80)}\n${'b'.repeat(40)}`);
    const w = textWindow(whole.subarray(0, 100), 0, whole.length);
    expect(w).toMatchObject({ text: `${'a'.repeat(80)}\n`, offset: 0, nextOffset: 81 });
    // A line break earlier than the last quarter does not shorten the window.
    const early = Buffer.from(`${'a'.repeat(10)}\n${'b'.repeat(200)}`);
    expect(textWindow(early.subarray(0, 100), 0, early.length).nextOffset).toBe(100);
  });

  test('an offset inside a character starts after it; the end of the file has no next offset', () => {
    const whole = Buffer.from('aéb', 'utf8'); // a, 2 bytes é, b
    expect(textWindow(whole.subarray(2), 2, whole.length)).toEqual({ text: 'b', offset: 3, nextOffset: null, binary: false });
    expect(textWindow(Buffer.alloc(0), 4, whole.length)).toEqual({ text: '', offset: 4, nextOffset: null, binary: false });
  });

  test('a NUL byte marks the window as not text', () => {
    expect(textWindow(Buffer.from([0x61, 0x00, 0x62]), 0, 3).binary).toBe(true);
  });
});
