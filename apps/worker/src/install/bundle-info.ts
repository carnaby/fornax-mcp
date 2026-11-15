import type { WorkerBundleInfo } from '@fornax/protocol';
import { networkErrorOf } from '../api.js';
import { InstallError } from './errors.js';

/** The largest bundle fornax update accepts (the real one is ~240 kB). */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

/** GET <server>/downloads/fornax-worker.json (spec 05c 6). NetworkError when unreachable, InstallError otherwise. */
export async function fetchBundleInfo(server: string, signal?: AbortSignal, timeoutMs = 15_000): Promise<WorkerBundleInfo> {
  const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${server.replace(/\/+$/, '')}/downloads/fornax-worker.json`, { signal: s });
  } catch (e) {
    throw networkErrorOf(e, s);
  }
  if (!res.ok) throw new InstallError(`the server has no worker bundle (HTTP ${res.status})`);
  const b = (await res.json().catch(() => null)) as Partial<WorkerBundleInfo> | null;
  const ok =
    b !== null &&
    typeof b.version === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(b.version) &&
    typeof b.sha256 === 'string' && /^[0-9a-f]{64}$/.test(b.sha256) &&
    Number.isInteger(b.size) && b.size! > 0 && b.size! <= MAX_BUNDLE_BYTES;
  if (!ok) throw new InstallError('the server answered something else than the worker bundle info');
  return b as WorkerBundleInfo;
}

/** Numeric comparison of dot-separated versions ("0.10.0" > "0.9.1"); a non-number part compares as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.+-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
