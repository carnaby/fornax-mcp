import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { type ClaimedJob, claimedJob, type JobTypeContract, type OutputsJson, WORKER_HEADERS } from '@fornax/protocol';
import { WORKER_VERSION } from './version.js';

/** The server answered with an error status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** 409: the lease no longer holds (the job was canceled, finished, retried or claimed again). Drop the job. */
export class LeaseLostError extends ApiError {}
/** The server could not be reached (refused, reset, DNS, TLS). */
export class NetworkError extends Error {}
/** A downloaded input does not match the size and SHA-256 the claim promised. */
export class InputMismatchError extends Error {}
/** A file to upload could not be read as it was when checked (it changed size, became a link or cannot be read). */
export class UploadFileError extends Error {}
/** A downloaded input could not be written on this PC (a local file-system error, not the network). No path in the message. */
export class LocalFileError extends Error {}

/** Worth trying again a little later. */
export const isTransient = (e: unknown): boolean =>
  e instanceof NetworkError || e instanceof InputMismatchError || (e instanceof ApiError && e.status >= 500);

export type ClaimedInput = ClaimedJob['inputs'][number];
export type WorkerQueue = { queued: number; running: number; unavailable: { type: string; count: number }[] };

type RequestOptions = { json?: unknown; body?: ReadableStream<Uint8Array>; headers?: Record<string, string>; signal?: AbortSignal };

const enc = encodeURIComponent;
/** The calls a write stream makes on its file; an error from one of them is a local problem. */
const FILE_SYSCALLS = new Set(['open', 'write', 'writev', 'close', 'fsync']);

/** The worker API of spec 8.3 (routes from plan 01), typed. */
export class WorkerApi {
  private readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(opts: { server: string; token: string }) {
    this.base = `${opts.server.replace(/\/+$/, '')}/api/worker`;
    this.headers = {
      authorization: `Bearer ${opts.token}`,
      [WORKER_HEADERS.name]: hostname().toLowerCase(),
      [WORKER_HEADERS.version]: WORKER_VERSION,
    };
  }

  private async request(method: string, path: string, init: RequestOptions = {}): Promise<Response> {
    const headers = { ...this.headers, ...init.headers, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) };
    const body = init.json !== undefined ? JSON.stringify(init.json) : init.body;
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers, body, signal: init.signal, ...(init.body ? { duplex: 'half' as const } : {}) });
    } catch (e) {
      // A caller's time limit (AbortSignal.timeout) is a server that did not answer: worth another try.
      if (init.signal?.aborted && (init.signal.reason as Error | undefined)?.name === 'TimeoutError') {
        throw new NetworkError('the server did not answer in time', { cause: e });
      }
      if (init.signal?.aborted) throw e;
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new NetworkError(`cannot reach the server: ${cause?.code ?? cause?.message ?? (e as Error).message}`, { cause: e });
    }
    if (res.ok) return res;
    let code = 'http_error';
    let message = `the server answered ${res.status}`;
    try {
      const b = (await res.json()) as { error?: unknown; message?: unknown };
      if (typeof b.error === 'string') code = b.error;
      if (typeof b.message === 'string') message = b.message;
    } catch {
      // Not JSON: keep the generic message.
    }
    throw res.status === 409 ? new LeaseLostError(409, code, message) : new ApiError(res.status, code, message);
  }

  /** A request whose answer body is not needed; reading it frees the connection. */
  private async send(method: string, path: string, init: RequestOptions = {}): Promise<void> {
    await (await this.request(method, path, init)).arrayBuffer();
  }

  async ping(): Promise<void> {
    await this.send('GET', '/ping');
  }

  async announce(types: JobTypeContract[]): Promise<string[]> {
    const res = await this.request('PUT', '/types', { json: { types } });
    return ((await res.json()) as { offered: string[] }).offered;
  }

  /** Long-poll for a job; null when none came within `wait` seconds. */
  async claim(wait: number, signal?: AbortSignal): Promise<ClaimedJob | null> {
    const res = await this.request('POST', '/jobs/claim', { json: { wait }, signal });
    if (res.status === 204) return null;
    return claimedJob.parse(await res.json());
  }

  async heartbeat(id: string, lease: string, progress: number | null, message: string | null, signal?: AbortSignal): Promise<{ cancel: boolean }> {
    const res = await this.request('POST', `/jobs/${enc(id)}/heartbeat`, { json: { lease, progress, message }, signal });
    return { cancel: ((await res.json()) as { cancel?: unknown }).cancel === true };
  }

  async fail(id: string, lease: string, error: string, permanent: boolean): Promise<'queued' | 'failed'> {
    const res = await this.request('POST', `/jobs/${enc(id)}/fail`, { json: { lease, error: error.slice(0, 10_000), permanent } });
    return ((await res.json()) as { state: 'queued' | 'failed' }).state;
  }

  async release(id: string, lease: string, signal?: AbortSignal): Promise<void> {
    await this.send('POST', `/jobs/${enc(id)}/release`, { json: { lease }, signal });
  }

  async complete(id: string, lease: string, outputs: OutputsJson): Promise<void> {
    await this.send('POST', `/jobs/${enc(id)}/complete`, { json: { lease, outputs } });
  }

  async queue(): Promise<WorkerQueue> {
    return (await (await this.request('GET', '/queue')).json()) as WorkerQueue;
  }

  /** Stream an input to `dest`; size and SHA-256 must match the claim, else the file is removed. */
  async downloadInput(id: string, lease: string, input: ClaimedInput, dest: string, signal?: AbortSignal): Promise<void> {
    const res = await this.request('GET', `/jobs/${enc(id)}/inputs/${enc(input.name)}`, { headers: { [WORKER_HEADERS.lease]: lease }, signal });
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        hash.update(chunk);
        done(null, chunk);
      },
    });
    if (!res.body) throw new NetworkError(`the download of input ${input.name} broke off: the answer has no body`);
    const source = Readable.fromWeb(res.body as unknown as WebReadableStream);
    const file = createWriteStream(dest);
    // pipeline destroys every stream with the first error, so the write stream also emits a network error.
    // Only an error of the file itself counts as local: not the body's, and from a file-system call.
    let sourceError: unknown = null;
    source.on('error', (e) => {
      sourceError ??= e;
    });
    let local: NodeJS.ErrnoException | null = null;
    file.on('error', (e: NodeJS.ErrnoException) => {
      if (e !== sourceError && FILE_SYSCALLS.has(e.syscall ?? '')) local ??= e;
    });
    try {
      // Aborting `signal` aborts the fetch, which errors this body stream.
      await pipeline(source, meter, file);
    } catch (e) {
      // A write stream destroyed while its file was still opening opens it afterwards: wait until it is closed,
      // or the removal below could run first and an empty file would be left behind.
      if (!file.closed) await new Promise((r) => file.once('close', r));
      await rm(dest, { force: true });
      if (signal?.aborted) throw e;
      // Writing here failed (missing directory, no permission, disk full): not worth retrying, and the code
      // stands in for the message, which holds this PC's absolute path.
      if (local) throw new LocalFileError(`input ${input.name} could not be written here (${(local as NodeJS.ErrnoException).code ?? 'write error'})`, { cause: e });
      throw new NetworkError(`the download of input ${input.name} broke off: ${(e as Error).message}`, { cause: e });
    }
    if (size !== input.size || hash.digest('hex') !== input.sha256) {
      await rm(dest, { force: true });
      throw new InputMismatchError(`input ${input.name} arrived damaged (${size} of ${input.size} bytes, or a different checksum)`);
    }
  }

  /**
   * Streamed PUT of one file with its content-length; `name` may contain "/". With `expectedSize` exactly that many
   * bytes are sent: a file that grew or shrank meanwhile (or, on Linux, became a link) is an UploadFileError.
   */
  async uploadOutput(
    id: string, lease: string, name: string, kind: 'output' | 'log', file: string, signal?: AbortSignal, expectedSize?: number,
  ): Promise<void> {
    const size = expectedSize ?? (await stat(file)).size;
    const path = `/jobs/${enc(id)}/outputs/${name.split('/').map(enc).join('/')}${kind === 'log' ? '?kind=log' : ''}`;
    let local: UploadFileError | null = null;
    async function* exactly(): AsyncGenerator<Buffer> {
      let sent = 0;
      try {
        // O_NOFOLLOW exists on Linux only; there a file swapped for a link is refused instead of followed.
        // The stream closes the handle when it ends, fails or is destroyed (an aborted upload).
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        for await (const chunk of handle.createReadStream()) {
          sent += (chunk as Buffer).length;
          if (sent > size) throw new UploadFileError(`the file grew past the ${size} bytes it had`);
          yield chunk as Buffer;
        }
      } catch (e) {
        // The code, not the message: the message holds this PC's absolute path.
        local = e instanceof UploadFileError ? e : new UploadFileError(`the file could not be read (${(e as NodeJS.ErrnoException).code ?? 'read error'})`, { cause: e });
        throw local;
      }
      if (sent !== size) {
        local = new UploadFileError(`the file shrank to ${sent} of the ${size} bytes it had`);
        throw local;
      }
    }
    const source = Readable.from(exactly());
    const body = Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>;
    try {
      await this.send('PUT', path, {
        body,
        headers: { [WORKER_HEADERS.lease]: lease, 'content-type': 'application/octet-stream', 'content-length': String(size) },
        signal,
      });
    } catch (e) {
      // A broken body surfaces from fetch as a network error; the real cause is the local file.
      if (local) throw local;
      throw e;
    } finally {
      // An answer (409, 413) can come before the body is read to its end: the stalled body would keep the file open.
      source.destroy();
    }
  }
}
