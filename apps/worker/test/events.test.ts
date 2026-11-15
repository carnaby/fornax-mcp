import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { eventLine, onInputEnd, readStops } from '../src/events.js';

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

const CR = String.fromCharCode(13);
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('eventLine', () => {
  test('one JSON object per line', () => {
    expect(eventLine({ event: 'stopped', code: 0 })).toBe('{"event":"stopped","code":0}\n');
    expect(JSON.parse(eventLine({ event: 'log', line: 'a "quoted" line' }))).toEqual({ event: 'log', line: 'a "quoted" line' });
  });
});

describe('readStops (spec 06 3.2)', () => {
  test('every stop line is a stop; other lines are ignored', async () => {
    const input = new PassThrough();
    let stops = 0;
    readStops(input, () => stops++);
    input.write('hello\nstop\n');
    await tick();
    expect(stops).toBe(1);
    input.write('stop\n');
    await tick();
    expect(stops).toBe(2);
  });

  test('CRLF and blanks around stop still count', async () => {
    const input = new PassThrough();
    let stops = 0;
    readStops(input, () => stops++);
    input.write(`  stop ${CR}\n`);
    await tick();
    expect(stops).toBe(1);
  });

  test('a closed input is one stop, but not after a stop already came', async () => {
    const first = new PassThrough();
    let a = 0;
    readStops(first, () => a++);
    first.end();
    await tick();
    expect(a).toBe(1);

    const second = new PassThrough();
    let b = 0;
    readStops(second, () => b++);
    second.write('stop\n');
    second.end();
    await tick();
    expect(b).toBe(1);
  });

  test('the cleanup is no stop and closes the input', async () => {
    const input = new PassThrough();
    let stops = 0;
    const stop = readStops(input, () => stops++);
    stop();
    await tick();
    expect(stops).toBe(0);
    expect(input.destroyed).toBe(true);
  });
});
