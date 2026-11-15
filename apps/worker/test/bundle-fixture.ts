import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { zipBuffer } from '../scripts/zip.mjs';

export type BundleOptions = {
  version?: string;
  /** Pack name → relative file path → content; type.yaml included by the caller. */
  packs?: Record<string, Record<string, string>>;
};

/** The files of a worker bundle as fornax-worker/<path> → content (a fake fornax.mjs that prints its version). */
export function bundleFiles(opts: BundleOptions = {}): Map<string, { data: string; mode: number }> {
  const version = opts.version ?? '9.9.9';
  const files = new Map<string, { data: string; mode: number }>([
    ['fornax.mjs', { data: `console.log(${JSON.stringify(version)});\n`, mode: 0o644 }],
    ['fornax', { data: '#!/bin/sh\nexec node "$(dirname "$(readlink -f "$0")")/fornax.mjs" "$@"\n', mode: 0o755 }],
    ['fornax.cmd', { data: '@echo off\r\nnode "%~dp0fornax.mjs" %*\r\n', mode: 0o644 }],
    ['VERSION', { data: `${version}\n`, mode: 0o644 }],
    ['LICENSE', { data: 'MIT\n', mode: 0o644 }],
    ['types/README.md', { data: '# Type packs\n', mode: 0o644 }],
  ]);
  for (const [pack, packFiles] of Object.entries(opts.packs ?? {})) {
    for (const [rel, data] of Object.entries(packFiles)) files.set(`types/${pack}/${rel}`, { data, mode: 0o644 });
  }
  return files;
}

/** A worker zip as the bundle writes it. */
export function workerZip(opts: BundleOptions = {}, extra: { name: string; data: Buffer; mode?: number }[] = []): Buffer {
  const entries = [...bundleFiles(opts)].map(([rel, f]) => ({ name: `fornax-worker/${rel}`, data: Buffer.from(f.data), mode: f.mode }));
  return zipBuffer([...entries, ...extra]);
}

/** An unzipped worker bundle in `dir`. */
export function writeWorkerDir(dir: string, opts: BundleOptions = {}): string {
  for (const [rel, f] of bundleFiles(opts)) {
    const file = join(dir, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, f.data, { mode: f.mode });
  }
  return dir;
}
