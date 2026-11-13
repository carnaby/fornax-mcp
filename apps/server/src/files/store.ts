import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, type ReadStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tooLarge } from '../domain/errors.js';

/** File contents live at <root>/<id>; partial writes in <root>/tmp. */
export class FileStore {
  readonly tmp: string;

  constructor(readonly root: string) {
    this.tmp = join(root, 'tmp');
    mkdirSync(this.tmp, { recursive: true });
  }

  pathOf(id: string): string {
    return join(this.root, id);
  }

  /** Stream into the store; over `maxBytes` the write stops with 413 and the partial file is removed. */
  async write(id: string, source: Readable, maxBytes: number): Promise<{ size: number; sha256: string }> {
    const part = join(this.tmp, `${id}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) return done(tooLarge(`the file is larger than ${Math.floor(maxBytes / 1024 / 1024)} MB`));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    // pipeline() destroys every stream it was given on error, which would kill the request socket
    // before the 413 reply is sent. The source is piped into a PassThrough instead, so only that is destroyed.
    const guard = new PassThrough();
    const onError = (err: Error) => guard.destroy(err);
    const onClose = () => {
      if (!source.readableEnded) guard.destroy(new Error('upload aborted'));
    };
    source.once('error', onError);
    source.once('close', onClose);
    try {
      source.pipe(guard);
      await pipeline(guard, meter, createWriteStream(part));
      await rename(part, this.pathOf(id));
    } catch (e) {
      // Stop reading; the rest of the body is never consumed (the caller closes the connection).
      source.unpipe(guard);
      source.pause();
      await rm(part, { force: true });
      throw e;
    } finally {
      source.off('error', onError);
      source.off('close', onClose);
    }
    return { size, sha256: hash.digest('hex') };
  }

  async remove(id: string): Promise<void> {
    await rm(this.pathOf(id), { force: true });
  }

  openRead(id: string): ReadStream {
    return createReadStream(this.pathOf(id));
  }

  /** The last `maxBytes` of a file as UTF-8, starting at a character boundary; truncated when anything was left out. */
  async tail(id: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
    const fh = await open(this.pathOf(id), 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      // Skip UTF-8 continuation bytes (10xxxxxx) of a character cut by the start.
      let skip = 0;
      while (start > 0 && skip < 3 && skip < buf.length && ((buf[skip] ?? 0) & 0xc0) === 0x80) skip++;
      return { text: buf.subarray(skip).toString('utf8'), truncated: start > 0 };
    } finally {
      await fh.close();
    }
  }
}
