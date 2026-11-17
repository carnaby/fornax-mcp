import { type ClientJobView, clientJobView, type Priority } from '@fornax/protocol';
import { apiErrorOf, NetworkError, networkErrorOf } from './api.js';

/** A long-poll answers within its wait; this much more is a server that does not answer. */
const ANSWER_MARGIN_MS = 15_000;
/** A plain request (whoami, submit, cancel). */
const REQUEST_TIMEOUT_MS = 30_000;

/** Without a priority the server takes the type's default (spec 07 § 4.4). */
export type LeaseSubmit = { type: string; params: Record<string, unknown>; priority?: Priority };

/** The client REST API (spec 8.2) as fornax lease uses it, with a client token. Errors are ApiError and NetworkError. */
export class ClientApi {
  private readonly base: string;
  private readonly token: string;

  constructor(opts: { server: string; token: string }) {
    this.base = `${opts.server.replace(/\/+$/, '')}/api`;
    this.token = opts.token;
  }

  private async request(method: string, path: string, init: { json?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
        signal,
      });
    } catch (e) {
      throw networkErrorOf(e, signal);
    }
    if (res.ok) return res;
    throw await apiErrorOf(res);
  }

  async whoami(signal?: AbortSignal): Promise<{ name: string; role: string }> {
    return (await (await this.request('GET', '/whoami', { signal })).json()) as { name: string; role: string };
  }

  async submit(body: LeaseSubmit, signal?: AbortSignal): Promise<ClientJobView> {
    return clientJobView.parse(await (await this.request('POST', '/jobs', { json: body, signal })).json());
  }

  /**
   * One job; with `wait`, the server answers when its change differs from `change`, at the latest after `wait` seconds.
   * An answer that cannot be read whole or parsed is a NetworkError: asking again is safe.
   */
  async job(id: string, opts: { wait?: number; change?: string; signal?: AbortSignal } = {}): Promise<ClientJobView> {
    const q = new URLSearchParams();
    if (opts.wait) q.set('wait', String(opts.wait));
    if (opts.change !== undefined) q.set('change', opts.change);
    const query = q.size ? `?${q.toString()}` : '';
    const res = await this.request('GET', `/jobs/${encodeURIComponent(id)}${query}`, {
      signal: opts.signal,
      timeoutMs: (opts.wait ?? 0) * 1000 + ANSWER_MARGIN_MS,
    });
    try {
      return clientJobView.parse(await res.json());
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new NetworkError('the server sent an answer that cannot be read', { cause: e });
    }
  }

  async cancel(id: string, signal?: AbortSignal): Promise<ClientJobView> {
    return clientJobView.parse(await (await this.request('POST', `/jobs/${encodeURIComponent(id)}/cancel`, { signal })).json());
  }
}
