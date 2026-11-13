import type { TokenRole } from '@fornax/protocol';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Identity, resolveToken } from '../domain/tokens.js';
import type { RouteDeps } from './deps.js';

declare module 'fastify' {
  interface FastifyRequest {
    identity?: Identity;
  }
}

export function bearerOf(req: FastifyRequest): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  return m ? m[1]! : null;
}

/** Resolve a raw token for a role and answer 401/403 when it does not open this API. */
export function authorize(deps: RouteDeps, raw: string | null, role: TokenRole, reply: FastifyReply): Identity | null {
  const r = raw ? resolveToken(deps.db, raw, deps.clock()) : null;
  if (r?.kind === 'pending') {
    void reply.code(403).send({ error: 'pending', message: `this token is waiting for approval; fingerprint ${r.fingerprint}` });
    return null;
  }
  // A token of the other role is answered like an unknown one.
  if (!r || r.identity.role !== role) {
    void reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
    return null;
  }
  return r.identity;
}

/** onRequest hook: runs before the body is read. */
export function requireRole(deps: RouteDeps, role: TokenRole) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = authorize(deps, bearerOf(req), role, reply);
    if (identity) req.identity = identity;
    return reply.sent ? reply : undefined;
  };
}
