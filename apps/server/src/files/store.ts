import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** File contents live at <root>/<id>; partial writes in <root>/tmp. */
export class FileStore {
  readonly tmp: string;

  constructor(readonly root: string) {
    this.tmp = join(root, 'tmp');
    mkdirSync(this.tmp, { recursive: true });
  }
}
