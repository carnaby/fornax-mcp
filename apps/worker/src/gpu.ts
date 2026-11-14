import { execFile } from 'node:child_process';
import { MAX_MIB } from '@fornax/protocol';

/** Spec 05a 2.2: the whole card's memory (on Windows/WDDM nvidia-smi gives no per-process figures). */
export const NVIDIA_SMI_ARGS = ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'];
export const GPU_TIMEOUT_MS = 5000;

export type GpuReading = { ok: true; used_mib: number; total_mib: number; cards: number } | { ok: false; error: string };

/**
 * One "used, total" line per card; card 0 counts (more cards are out of scope). Null for anything else, also for a
 * figure above MAX_MIB: no real card has that much, and the server refuses such a status.
 */
export function parseNvidiaSmi(stdout: string): { used_mib: number; total_mib: number; cards: number } | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const cards = lines.map((l) => /^(\d{1,9})\s*,\s*(\d{1,9})$/.exec(l));
  if (cards.some((m) => m === null || Number(m[1]) > MAX_MIB || Number(m[2]) > MAX_MIB)) return null;
  const first = cards[0]!;
  return { used_mib: Number(first[1]), total_mib: Number(first[2]), cards: lines.length };
}

/**
 * Read the card through nvidia-smi: async, without a shell, cut off after `timeoutMs`. Never rejects; a failure is
 * one short reason starting with "nvidia-smi: " (it is shown to clients and in fornax doctor, so never a path).
 * `command` replaces nvidia-smi (program and leading arguments) in tests.
 */
export function readGpu(opts: { command?: string[]; timeoutMs?: number } = {}): Promise<GpuReading> {
  const [program, ...lead] = opts.command ?? ['nvidia-smi'];
  const timeoutMs = opts.timeoutMs ?? GPU_TIMEOUT_MS;
  const noAnswer: GpuReading = { ok: false, error: `nvidia-smi: no answer within ${timeoutMs / 1000} s` };
  return new Promise((resolve) => {
    let guard: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (reading: GpuReading) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(reading);
    };
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        program ?? '',
        [...lead, ...NVIDIA_SMI_ARGS],
        { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 },
        (e, stdout) => {
          if (e) {
            const err = e as NodeJS.ErrnoException & { killed?: boolean; code?: string | number | null };
            if (err.code === 'ENOENT') return settle({ ok: false, error: 'nvidia-smi: not found' });
            if (err.killed) return settle(noAnswer);
            if (typeof err.code === 'number') return settle({ ok: false, error: `nvidia-smi: exit code ${err.code}` });
            return settle({ ok: false, error: `nvidia-smi: ${err.code ?? 'cannot start'}` });
          }
          const card = parseNvidiaSmi(stdout);
          settle(card ? { ok: true, ...card } : { ok: false, error: 'nvidia-smi: unreadable output' });
        },
      );
    } catch {
      return settle({ ok: false, error: 'nvidia-smi: cannot start' });
    }
    // execFile's own timeout kills and then waits for the pipes to close, which may never happen (a process stuck in
    // the driver, or a descendant holding stdout open). This guard answers on time regardless and lets go of the pipes.
    guard = setTimeout(() => {
      settle(noAnswer);
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, timeoutMs);
  });
}

/** fornax doctor's suggestion for gpu.max_used_mib: what is in use now plus 768 MiB, rounded up to a multiple of 256. */
export const suggestedLimit = (usedMib: number): number => Math.ceil((usedMib + 768) / 256) * 256;

export type DoctorLine = { level: 'ok' | 'WARN' | 'FAIL'; text: string };

/** Spec 05a 2.5: the gpu lines of fornax doctor. A failed reading fails only when the worker relies on it (a limit). */
export function doctorGpuLines(r: GpuReading, limit: number | null): DoctorLine[] {
  if (!r.ok) return [{ level: limit === null ? 'WARN' : 'FAIL', text: `gpu: ${r.error}` }];
  const use = `gpu: ${r.used_mib} of ${r.total_mib} MiB in use`;
  const lines: DoctorLine[] =
    limit === null
      ? [{ level: 'WARN', text: `${use}; gpu.max_used_mib is not set, the worker does not check the card (suggested: ${suggestedLimit(r.used_mib)})` }]
      : r.used_mib > limit
        ? [{ level: 'WARN', text: `${use}, over the limit ${limit}: the worker waits now` }]
        : [{ level: 'ok', text: `${use}, limit ${limit}` }];
  if (r.cards > 1) lines.push({ level: 'WARN', text: `gpu: ${r.cards} cards found, only the first is checked` });
  return lines;
}
