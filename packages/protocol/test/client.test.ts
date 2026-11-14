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
