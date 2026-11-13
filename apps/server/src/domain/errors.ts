/** An error the client may see: status, a stable code and a short message without internals. */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new DomainError(400, 'bad_request', m);
export const notFound = (m = 'not found') => new DomainError(404, 'not_found', m);
export const conflict = (m: string) => new DomainError(409, 'conflict', m);
export const tooLarge = (m: string) => new DomainError(413, 'too_large', m);
export const unprocessable = (m: string) => new DomainError(422, 'invalid', m);
export const tooMany = (m: string) => new DomainError(429, 'too_many', m);
