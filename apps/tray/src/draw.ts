// What a new snapshot redraws (final review 06e). The card's numbers change every few seconds; redrawing the lists for
// them would wipe a text selection and could drop a click, so the GPU strip has a key of its own.
import type { Snapshot } from './types';

export type DrawKeys = { gpu: string; rest: string };
export type DrawPlan = { keys: DrawKeys; gpu: boolean; rest: boolean };

/** `prev`: the keys drawn last (null before the first paint). */
export function drawPlan(prev: DrawKeys | null, s: Snapshot): DrawPlan {
  const keys = {
    gpu: JSON.stringify([s.gpu, s.gpuHolder, s.cardWait]),
    rest: JSON.stringify({ ...s, gpu: null }),
  };
  return { keys, gpu: prev?.gpu !== keys.gpu, rest: prev?.rest !== keys.rest };
}
