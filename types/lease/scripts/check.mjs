// The lease type's check: the folder where fornax lease and the tool talk must be writable.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const leasesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'leases');
const probe = join(leasesDir, `.check-${process.pid}`);
try {
  mkdirSync(leasesDir, { recursive: true });
  writeFileSync(probe, '');
  rmSync(probe, { force: true });
} catch (e) {
  // The code, not the message: the message holds this PC's path.
  console.error(`the lease folder cannot be written (${e.code ?? 'error'})`);
  process.exit(1);
}
