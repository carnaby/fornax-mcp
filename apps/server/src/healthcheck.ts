import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Whether this machine's Fornax answers GET /healthz with 200 within `timeoutMs`. */
export async function healthy(port: string | number, timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return res.status === 200;
  } catch {
    return false;
  }
}

// The image's health command: node /app/dist/src/healthcheck.js (exit 0 healthy, 1 not).
const isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) process.exit((await healthy(process.env.PORT ?? '3000')) ? 0 : 1);
