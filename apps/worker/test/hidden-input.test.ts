import { PassThrough, Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { readAllLimited, readHiddenLine } from '../src/hidden-input.js';

function fakeTerminal() {
  const modes: boolean[] = [];
  const input = Object.assign(new PassThrough(), { setRawMode: (on: boolean) => modes.push(on) });
  const written: string[] = [];
  return { input, modes, output: { write: (t: string) => written.push(t) }, written };
}

describe('hidden input (spec 08 § 3.1)', () => {
  test('no echo: only the prompt and a line end are written; Backspace deletes; Enter ends; raw mode on, then off', async () => {
    const { input, modes, output, written } = fakeTerminal();
    const line = readHiddenLine(input, output, 'EXAMPLE_TOKEN: ');
    input.write('hf_tesx');
    input.write(String.fromCharCode(127));
    input.write(`t_value_123${String.fromCharCode(13)}ignored`);
    expect(await line).toBe('hf_test_value_123');
    expect(written.join('')).toBe('EXAMPLE_TOKEN: \n');
    expect(modes).toEqual([true, false]);
  });

  test('Ctrl+C cancels', async () => {
    const { input, output } = fakeTerminal();
    const line = readHiddenLine(input, output, 'X: ');
    input.write(`hf${String.fromCharCode(3)}`);
    expect(await line).toBeNull();
  });

  test('piped input is read whole, up to a limit', async () => {
    expect(await readAllLimited(Readable.from(['hf_test_', 'value_123\n']), 100)).toBe('hf_test_value_123\n');
    expect(await readAllLimited(Readable.from(['x'.repeat(60), 'x'.repeat(60)]), 100)).toBeNull();
  });
});
