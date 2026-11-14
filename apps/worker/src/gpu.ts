import { execFile } from 'node:child_process';

/** Spec 05a 2.2: the whole card's memory (on Windows/WDDM nvidia-smi gives no per-process figures). */
export const NVIDIA_SMI_ARGS = ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'];
export const GPU_TIMEOUT_MS = 5000;

export type GpuReading = { ok: true; used_mib: number; total_mib: number; cards: number } | { ok: false; error: string };

/** One "used, total" line per card; card 0 counts (more cards are out of scope). Null for anything else. */
export function parseNvidiaSmi(stdout: string): { used_mib: number; total_mib: number; cards: number } | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const cards = lines.map((l) => /^(\d{1,9})\s*,\s*(\d{1,9})$/.exec(l));
  if (cards.some((m) => m === null)) return null;
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
  return new Promise((resolve) => {
    execFile(
      program!,
      [...lead, ...NVIDIA_SMI_ARGS],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 },
      (e, stdout) => {
        if (e) {
          const err = e as NodeJS.ErrnoException & { killed?: boolean; code?: string | number | null };
          if (err.code === 'ENOENT') return resolve({ ok: false, error: 'nvidia-smi: not found' });
          if (err.killed) return resolve({ ok: false, error: `nvidia-smi: no answer within ${timeoutMs / 1000} s` });
          if (typeof err.code === 'number') return resolve({ ok: false, error: `nvidia-smi: exit code ${err.code}` });
          return resolve({ ok: false, error: `nvidia-smi: ${err.code ?? 'cannot start'}` });
        }
        const card = parseNvidiaSmi(stdout);
        resolve(card ? { ok: true, ...card } : { ok: false, error: 'nvidia-smi: unreadable output' });
      },
    );
  });
}
