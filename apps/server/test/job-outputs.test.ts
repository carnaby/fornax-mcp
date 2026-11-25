import { describe, expect, test } from 'vitest';
import { OUTPUTS_PAGE, outputsSummary, pageOutputs } from '../src/mcp/job-outputs.js';

const out = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `frame_${i + 1}.png`, size: 10 + i }));
const view = (n: number | null) => ({ id: 'J', change: 'c', outputs: n === null ? null : out(n) });

describe('pageOutputs (spec 13 § 5.1)', () => {
  test('the first 20 by default, with the counts and where the next page starts', () => {
    const p = pageOutputs(view(120), 0, OUTPUTS_PAGE);
    expect(p.outputs!.map((o) => o.name)).toEqual(out(20).map((o) => o.name));
    expect(p).toMatchObject({ id: 'J', change: 'c', outputs_total: 120, outputs_next_offset: 20 });
    expect(p.outputs_bytes).toBe(out(120).reduce((s, o) => s + o.size, 0));
  });

  test('the last page has no next offset', () => {
    const p = pageOutputs(view(45), 40, 20);
    expect(p.outputs!.map((o) => o.name)).toEqual(['frame_41.png', 'frame_42.png', 'frame_43.png', 'frame_44.png', 'frame_45.png']);
    expect(p.outputs_next_offset).toBeNull();
  });

  test('an offset past the end gives an empty page', () => {
    expect(pageOutputs(view(120), 120, 20)).toMatchObject({ outputs: [], outputs_total: 120, outputs_next_offset: null });
    expect(pageOutputs(view(3), 500, 20)).toMatchObject({ outputs: [], outputs_total: 3, outputs_next_offset: null });
  });

  test('a job without outputs has null counts', () => {
    expect(pageOutputs(view(null), 0, 20)).toMatchObject({ outputs: null, outputs_total: null, outputs_bytes: null, outputs_next_offset: null });
  });

  test('a job with no files has zero counts', () => {
    expect(pageOutputs(view(0), 0, 20)).toMatchObject({ outputs: [], outputs_total: 0, outputs_bytes: 0, outputs_next_offset: null });
  });
});

describe('outputsSummary (spec 13 § 5.2)', () => {
  test('the counts instead of the list', () => {
    const s = outputsSummary(view(3));
    expect(s).toEqual({ id: 'J', change: 'c', outputs_total: 3, outputs_bytes: 33 });
    expect(outputsSummary(view(null))).toEqual({ id: 'J', change: 'c', outputs_total: null, outputs_bytes: null });
  });
});
