import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { cleanOutputName, type OutputsJson, outputsJson } from '@fornax/protocol';
import { z } from 'zod';

export const OUTPUTS_JSON = 'outputs.json';
/** The job log's name on the server; no output may take it. */
export const LOG_NAME = 'log.txt';
export const MAX_OUTPUTS = 1000;
/** outputs.json is read into memory: at most this many bytes. */
export const MAX_OUTPUTS_JSON = 1024 * 1024;

export type OutputFile = { name: string; path: string; size: number };
export type CollectedOutputs = { files: OutputFile[]; info: OutputsJson };

/** The tool left something in out/ that cannot be uploaded safely; the job fails for good with this message. */
export class OutputError extends Error {}

const outside = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);

async function readOutputsJson(file: string, names: Set<string>): Promise<OutputsJson> {
  let text: string;
  try {
    // At most one byte past the limit is read, also when the file grew after it was listed.
    const handle = await open(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_OUTPUTS_JSON + 1);
      let size = 0;
      while (size < buf.length) {
        const { bytesRead } = await handle.read(buf, size, buf.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > MAX_OUTPUTS_JSON) throw new OutputError(`out/${OUTPUTS_JSON} is larger than 1 MiB`);
      text = buf.subarray(0, size).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OutputError(`${OUTPUTS_JSON} is not valid JSON`);
  }
  const r = outputsJson.safeParse(raw);
  if (!r.success) throw new OutputError(`${OUTPUTS_JSON}: ${z.prettifyError(r.error)}`);
  for (const [name, info] of Object.entries(r.data)) {
    if (!names.has(name)) throw new OutputError(`${OUTPUTS_JSON} names ${name}, which is not in out/`);
    if (info.preview === undefined) continue;
    if (info.preview === name) throw new OutputError(`${OUTPUTS_JSON}: ${name} cannot be its own preview`);
    if (!names.has(info.preview)) throw new OutputError(`${OUTPUTS_JSON}: preview ${info.preview} of ${name} is not in out/`);
    if (Object.hasOwn(r.data, info.preview)) {
      throw new OutputError(`${OUTPUTS_JSON}: preview ${info.preview} of ${name} is itself a listed output; a preview must be a separate file`);
    }
  }
  return r.data;
}

/** Every file under out/ as an output (spec 6.4), checked before anything is uploaded. */
export async function collectOutputs(outDir: string): Promise<CollectedOutputs> {
  const root = await realpath(outDir);
  const files: OutputFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const full = join(dir, entry);
      const rel = relative(outDir, full).split(sep).join('/');
      const st = await lstat(full);
      // Links (and Windows junctions) are never followed: one could point at any file on this PC.
      if (st.isSymbolicLink()) throw new OutputError(`out/${rel} is a link; outputs must be plain files inside the output directory`);
      if (st.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!st.isFile()) throw new OutputError(`out/${rel} is not a plain file`);
      if (outside(relative(root, await realpath(full)))) throw new OutputError(`out/${rel} resolves outside the output directory`);
      if (rel === OUTPUTS_JSON) continue;
      const name = cleanOutputName(rel);
      if (!name) {
        throw new OutputError(`out/${rel}: an output name is a relative path of ASCII letters, digits, ".", "_" and "-" (no leading dot, no Windows device names, at most 8 levels)`);
      }
      if (name.toLowerCase() === LOG_NAME) throw new OutputError(`out/${rel}: ${LOG_NAME} is reserved for the job log`);
      files.push({ name, path: full, size: st.size });
      if (files.length > MAX_OUTPUTS) throw new OutputError(`out/ holds more than ${MAX_OUTPUTS} files`);
    }
  };
  await walk(outDir);
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lower = new Map<string, string>();
  for (const f of files) {
    const twin = lower.get(f.name.toLowerCase());
    if (twin) throw new OutputError(`out/${f.name} and out/${twin} differ only in letter case (one would overwrite the other on Windows)`);
    lower.set(f.name.toLowerCase(), f.name);
  }
  return { files, info: await readOutputsJson(join(outDir, OUTPUTS_JSON), new Set(files.map((f) => f.name))) };
}
