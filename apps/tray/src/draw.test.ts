import { describe, expect, test } from 'vitest';
import { base } from '../preview/fixtures';
import { drawPlan } from './draw';

describe('what a new snapshot redraws (final review 06e, Important 2)', () => {
  test('a change of the card only redraws the GPU strip, not the lists (a selection and a click survive)', () => {
    const s = base();
    const first = drawPlan(null, s);
    expect([first.gpu, first.rest]).toEqual([true, true]);
    const warmer = { ...s, gpu: { ...s.gpu, temperature: 72, utilization: 95 } };
    const next = drawPlan(first.keys, warmer);
    expect([next.gpu, next.rest]).toEqual([true, false]);
    expect(drawPlan(next.keys, warmer)).toMatchObject({ gpu: false, rest: false });
  });
  test('any other change redraws the rest; the worker waiting for the card redraws both', () => {
    const s = base();
    const first = drawPlan(null, s);
    expect(drawPlan(first.keys, { ...s, paused: true })).toMatchObject({ gpu: false, rest: true });
    const waiting = { ...s, cardWait: { reason: 'gpu_busy', usedMib: 8_396, totalMib: 16_311, limitMib: 768, error: null } };
    expect(drawPlan(first.keys, waiting)).toMatchObject({ gpu: true, rest: true });
  });
});
