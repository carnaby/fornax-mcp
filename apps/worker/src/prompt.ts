import { spawnSync } from 'node:child_process';
import { arch, release } from 'node:os';
import { join } from 'node:path';

export type PromptInput = {
  name: string;
  packDir: string;
  system: string;
  gpu: string;
  /** types/README.md, or null when it was not shipped. */
  formatDoc: string | null;
  examples: { name: string; yaml: string }[];
};

const FENCE = '```';

export const systemSummary = (): string => `${process.platform} ${release()} (${arch()})`;

/** GPU names and memory from nvidia-smi, when there is one. */
export function gpuSummary(): string {
  const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (r.error || r.status !== 0 || !r.stdout.trim()) return 'no NVIDIA GPU found (nvidia-smi is not available)';
  return r.stdout.trim().split(/\r?\n/).join('; ');
}

/** The prompt `fornax types add` hands to Claude (spec 7.3). */
export function buildTypePrompt(p: PromptInput): string {
  const env = join(p.packDir, 'env');
  const examples = p.examples.length
    ? p.examples.flatMap((e) => [`### ${e.name}/type.yaml`, '', `${FENCE}yaml`, e.yaml.trimEnd(), FENCE, ''])
    : ['(no built-in type packs ship with this worker yet)', ''];
  return [
    `Set up a new Fornax job type "${p.name}" on this PC.`,
    '',
    `Pack directory: ${p.packDir}`,
    `System: ${p.system}`,
    `GPU: ${p.gpu}`,
    '',
    '## The type pack format',
    '',
    p.formatDoc?.trim() ?? 'The format description (types/README.md) was not found next to the fornax CLI; ask me for it.',
    '',
    '## Examples',
    '',
    ...examples,
    '## Rules',
    '',
    '- Never run a tool in a mode that executes the content of an input file (Blender: always --disable-autoexec; no macros, no "load and run").',
    '- Keep parameter schemas strict: enums, bounded numbers, patterns and maxLength; nothing free-form that ends up on a command line.',
    '- Inputs reach the tool only through {input.<name>}; never build a file path from a parameter.',
    `- Install everything (venv, packages, models, downloads) only into ${env}; change nothing outside the pack directory.`,
    '- Exit codes: 0 done, 1 the job failed (it may be retried), 2 invalid input (never retried), 3 broken environment (no GPU, missing model).',
    '',
    '## Steps',
    '',
    '1. First ask me about the model, the quality and any other choices this type needs. Install nothing before I answer.',
    `2. Install what is needed into ${env} only.`,
    `3. Write type.yaml, setup.md and the scripts in ${join(p.packDir, 'scripts')}.`,
    `4. Run \`fornax doctor ${p.name}\` and fix what it reports until it passes.`,
  ].join('\n');
}
