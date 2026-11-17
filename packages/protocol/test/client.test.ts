import { expect, test } from 'vitest';
import { clientJobView } from '../src/index.js';

const job = {
  id: '01J', type: 'lease', state: 'queued', started_at: null, finished_at: null, position: 1, error: null,
  change: '0123456789abcdef', note: 'waiting, position 1; the worker takes it next', priority: 'normal',
};

test('a job answer as fornax lease reads it: extra fields are dropped, the state is one of five', () => {
  const { priority: _p, ...known } = job;
  expect(clientJobView.parse(job)).toEqual(known);
  const { note: _n, ...withoutNote } = known;
  expect(clientJobView.parse(withoutNote)).toEqual(withoutNote);
  expect(clientJobView.safeParse({ ...job, state: 'done' }).success).toBe(false);
  expect(clientJobView.safeParse({ ...job, change: undefined }).success).toBe(false);
});

import { describe } from 'vitest';
import { PRIORITIES, priorityInput } from '../src/client.js';

describe('priorities (spec 07 § 2.1)', () => {
  test('the stored value is the index: idle 0, normal 1, high 2', () => {
    expect(PRIORITIES).toEqual(['idle', 'normal', 'high']);
  });

  test('input takes low and stores normal; the others pass; anything else fails', () => {
    expect(priorityInput.parse('low')).toBe('normal');
    expect(priorityInput.parse('idle')).toBe('idle');
    expect(priorityInput.parse('normal')).toBe('normal');
    expect(priorityInput.parse('high')).toBe('high');
    expect(priorityInput.safeParse('urgent').success).toBe(false);
  });
});
