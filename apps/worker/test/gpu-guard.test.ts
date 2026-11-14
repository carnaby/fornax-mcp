import { expect, test, vi } from 'vitest';

// A child that never ends: execFile's callback never fires (as for a nvidia-smi stuck in the driver, which no
// signal ends). Mocked because no real process can be made to ignore SIGKILL on purpose.
const kill = vi.fn(() => true);
vi.mock('node:child_process', () => ({ execFile: vi.fn(() => ({ kill, stdout: null, stderr: null })) }));

const { readGpu } = await import('../src/gpu.js');

test('readGpu answers on time even when nvidia-smi never ends', async () => {
  const t0 = Date.now();
  expect(await readGpu({ timeoutMs: 200 })).toEqual({ ok: false, error: 'nvidia-smi: no answer within 0.2 s' });
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(kill).toHaveBeenCalledWith('SIGKILL');
});
