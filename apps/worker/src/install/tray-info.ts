import type { TrayBundleInfo, TrayInstallerInfo } from '@fornax/protocol';
import { networkErrorOf } from '../api.js';
import { VERSION_TEXT } from './app.js';
import { InstallError } from './errors.js';

/** The largest tray installer accepted (the real ones are 3-5 MB). */
export const MAX_TRAY_BYTES = 256 * 1024 * 1024;

const installerOk = (i: unknown): i is TrayInstallerInfo | null => {
  if (i === null) return true;
  if (typeof i !== 'object') return false;
  const { sha256, size } = i as Partial<TrayInstallerInfo>;
  return typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) && Number.isInteger(size) && size! > 0 && size! <= MAX_TRAY_BYTES;
};

/** GET <server>/downloads/fornax-tray.json (spec 06d 2.1). NetworkError when unreachable, InstallError otherwise. */
export async function fetchTrayInfo(server: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<TrayBundleInfo> {
  const s = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  let res: Response;
  try {
    res = await fetchImpl(`${server.replace(/\/+$/, '')}/downloads/fornax-tray.json`, { signal: s });
  } catch (e) {
    throw networkErrorOf(e, s);
  }
  // A server before 0.7.0 has no such route; a newer one built without the installers answers 404 too.
  if (res.status === 404) throw new InstallError('the server has no tray installer (it is older than 0.7.0, or was built without one)');
  if (!res.ok) throw new InstallError(`the server has no tray installer (HTTP ${res.status})`);
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw networkErrorOf(e, s);
  }
  let b: Partial<TrayBundleInfo> | null;
  try {
    b = JSON.parse(text) as Partial<TrayBundleInfo> | null;
  } catch {
    b = null;
  }
  const ok = b !== null && typeof b.version === 'string' && VERSION_TEXT.test(b.version) && installerOk(b.msi) && installerOk(b.deb);
  if (!ok) throw new InstallError('the server answered something else than the tray installer info');
  return b as TrayBundleInfo;
}
