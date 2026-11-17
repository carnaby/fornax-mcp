import { describe, expect, test } from 'vitest';
import { MAX_HELD, maskAll, Redactor } from '../src/redact.js';

const V = 'hf_test_value_123';

describe('masking (spec 08 § 4.3)', () => {
  test('every occurrence, the longest value first', () => {
    expect(maskAll(`a ${V} b ${V}`, [V])).toBe('a *** b ***');
    expect(maskAll(`x ${V}_long`, ['hf_test', `${V}_long`])).toBe('x ***');
    expect(maskAll('nothing', [])).toBe('nothing');
  });

  function collect(values: string[]) {
    const out: string[] = [];
    return { r: new Redactor(values, (t) => out.push(t)), text: () => out.join('') };
  }

  test('a value split between two chunks is masked; text is held only until its line ends', () => {
    const { r, text } = collect([V]);
    r.push('token hf_test');
    expect(text()).toBe('');
    r.push('_value_123 done\nnext ');
    expect(text()).toBe('token *** done\n');
    r.push(V);
    r.flush();
    expect(text()).toBe('token *** done\nnext ***');
  });

  test('a line longer than MAX_HELD goes out without its end, and a value across the cut is still masked', () => {
    const { r, text } = collect([V]);
    r.push(`${'x'.repeat(MAX_HELD)}hf_test_va`);
    expect(text().length).toBeGreaterThan(0);
    r.push('lue_123\n');
    expect(text()).toBe(`${'x'.repeat(MAX_HELD)}***\n`);
  });

  test('without values the text passes at once', () => {
    const { r, text } = collect([]);
    r.push('half a line');
    expect(text()).toBe('half a line');
  });

  test('a carriage return ends a line too: progress bars that redraw one line come out at once (final review #2)', () => {
    const { r, text } = collect([V]);
    r.push(`10%${String.fromCharCode(13)}`);
    expect(text()).toBe(`10%${String.fromCharCode(13)}`);
    r.push(`20% ${V}${String.fromCharCode(13)}`);
    expect(text()).toBe(`10%${String.fromCharCode(13)}20% ***${String.fromCharCode(13)}`);
  });
});
