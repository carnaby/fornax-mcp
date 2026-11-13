import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The `types/` directory shipped with Fornax, marked by its README.md: next to the bundled CLI (plan 04), or the
 * repository's during development. Searched upwards from `from`, at most 6 levels.
 */
export function shippedTypesDir(from: string = here): string | null {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'types', 'README.md'))) return join(dir, 'types');
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** A built-in pack's directory; `name` must already match TYPE_NAME. */
export function shippedPack(name: string, from?: string): string | null {
  const root = shippedTypesDir(from);
  const dir = root ? join(root, name) : null;
  return dir && existsSync(join(dir, 'type.yaml')) ? dir : null;
}

/** type.yaml of every built-in pack: the examples in the prompt for a new type. */
export function shippedExamples(from?: string): { name: string; yaml: string }[] {
  const root = shippedTypesDir(from);
  if (!root) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'type.yaml')))
    .map((d) => ({ name: d.name, yaml: readFileSync(join(root, d.name, 'type.yaml'), 'utf8') }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The type pack format (types/README.md), or null when it was not shipped. */
export function readShippedDoc(from?: string): string | null {
  const root = shippedTypesDir(from);
  return root ? readFileSync(join(root, 'README.md'), 'utf8') : null;
}
