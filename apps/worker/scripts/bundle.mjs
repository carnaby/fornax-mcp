// pnpm bundle:worker — the worker CLI as one fornax.mjs (esbuild, no dependencies left), zipped with the built-in type
// packs, launchers and the licence (spec 3). The CLI finds types/ next to itself (shippedTypesDir).
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipBuffer } from './zip.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Never shipped: Python tests and caches, and environments a setup made. */
const SKIP = new Set(['tests', '__pycache__', 'env']);

/** @param {string} outDir */
export async function bundleWorker(outDir) {
  const { version } = JSON.parse(readFileSync(join(repo, 'apps', 'worker', 'package.json'), 'utf8'));
  const stage = join(outDir, 'fornax-worker');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  await build({
    entryPoints: [join(repo, 'apps', 'worker', 'src', 'cli.ts')],
    outfile: join(stage, 'fornax.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // The workspace packages' TypeScript sources (protocol), as in development.
    conditions: ['fornax-source'],
    // CommonJS dependencies (yaml) call require() for Node built-ins.
    banner: { js: "import { createRequire as __fornaxCreateRequire } from 'node:module'; const require = __fornaxCreateRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  });

  const types = join(repo, 'types');
  cpSync(types, join(stage, 'types'), { recursive: true, filter: (src) => !relative(types, src).split(sep).some((part) => SKIP.has(part)) });
  cpSync(join(repo, 'LICENSE'), join(stage, 'LICENSE'));
  // fornax.cmd must stay byte-identical across versions: cmd.exe re-reads a running batch file at its saved offset after
  // each command, and fornax update swaps this file in under a launcher that is still running.
  writeFileSync(join(stage, 'fornax.cmd'), '@echo off\r\nnode "%~dp0fornax.mjs" %*\r\n');
  writeFileSync(join(stage, 'fornax'), '#!/bin/sh\nexec node "$(dirname "$(readlink -f "$0")")/fornax.mjs" "$@"\n');
  chmodSync(join(stage, 'fornax'), 0o755);
  // fornax install and fornax update read the version from here (spec 05c 4.1), never by running the program.
  writeFileSync(join(stage, 'VERSION'), `${version}\n`);

  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const rel = relative(stage, path).split(sep).join('/');
      entries.push({ name: `fornax-worker/${rel}`, data: readFileSync(path), mode: rel === 'fornax' ? 0o755 : 0o644 });
    }
  };
  walk(stage);
  const zip = join(outDir, `fornax-worker-${version}.zip`);
  writeFileSync(zip, zipBuffer(entries));
  return { zip, stage, version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await bundleWorker(resolve(process.argv[2] ?? join(repo, 'dist', 'worker')));
  console.log(`wrote ${r.zip}`);
}
