// The GPU strip (spec 06e § 2.3): the tray's own reading of the card, who holds it, and why the next job waits.
import { cardBusySentence, gb, holderText } from './text';
import type { Snapshot } from './types';
import { el, make } from './ui';

export function renderGpu(s: Snapshot): void {
  const g = s.gpu;
  const head = make('div', 'gpu-head');
  head.append(make('span', 'label', g.name ? `GPU · ${g.name}` : 'GPU'));
  const parts: HTMLElement[] = [head];
  let tone = s.gpuHolder.kind === 'lease' ? 'lease' : s.gpuHolder.kind === 'outside' ? 'error' : 'normal';
  if (g.state === 'ok' && g.usedMib !== null && g.totalMib !== null) {
    const facts = [holderText(s), g.utilization === null ? '' : `${g.utilization} %`, g.temperature === null ? '' : `${g.temperature} °C`];
    head.append(make('span', 'gpu-facts', facts.filter(Boolean).join(' · ')));
    const track = make('div', 'track');
    const fill = make('div');
    fill.style.width = `${Math.min(100, Math.round((g.usedMib / g.totalMib) * 100))}%`;
    track.append(fill);
    const row = make('div', 'gpu-bar-row');
    row.append(track, make('span', 'gpu-mem', `${gb(g.usedMib)} / ${gb(g.totalMib)} GB`));
    parts.push(row);
  } else if (g.state === 'failed') {
    tone = 'error';
    parts.push(make('p', 'gpu-sentence', `Card not connected: ${g.problem ?? 'it cannot be read'}`));
  } else {
    parts.push(make('p', 'gpu-sentence muted', g.state === 'missing' ? 'No NVIDIA card found' : 'Reading the card…'));
  }
  const busy = s.cardWait ? cardBusySentence(s.cardWait) : null;
  if (busy) parts.push(make('p', 'gpu-sentence', busy));
  const box = el('gpu');
  box.dataset.tone = tone;
  box.replaceChildren(...parts);
}
