import { createHmac, timingSafeEqual } from 'node:crypto';

const mac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

const PURPOSE = /^[a-z]+$/;

/** `<payload>.<expires unix s>.<hmac>`; payload must not contain a dot. The purpose is bound into the MAC, not the string. */
export function sign(secret: string, purpose: string, payload: string, expiresAt: Date): string {
  if (!PURPOSE.test(purpose)) throw new Error('purpose must be [a-z]+');
  if (payload.includes('.')) throw new Error('payload must not contain "."');
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return `${payload}.${exp}.${mac(secret, `${purpose}:${payload}.${exp}`)}`;
}

/** The payload when the signature is valid and not expired; otherwise null. */
export function verify(secret: string, purpose: string, signed: string, now: Date): string | null {
  const parts = signed.split('.');
  if (parts.length !== 3) return null;
  const [payload, exp, sig] = parts as [string, string, string];
  if (!/^\d{1,12}$/.test(exp) || Number(exp) * 1000 <= now.getTime()) return null;
  const want = Buffer.from(mac(secret, `${purpose}:${payload}.${exp}`));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? payload : null;
}
