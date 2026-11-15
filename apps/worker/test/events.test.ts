import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { onInputEnd } from '../src/events.js';

describe('onInputEnd', () => {
  test('calls back once when the input ends', async () => {
    const input = new PassThrough();
    let calls = 0;
    onInputEnd(input, () => calls++);
    input.write('anything\n');
    input.end();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
  });

  test('the cleanup stops listening and closes the input', async () => {
    const input = new PassThrough();
    let calls = 0;
    const stop = onInputEnd(input, () => calls++);
    stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
    expect(input.destroyed).toBe(true);
  });
});
