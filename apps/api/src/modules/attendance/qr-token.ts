import crypto from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Rotating QR tokens: token = base64url(payload).hmac, payload = { q: qrSessionId, w: window }.
 * window = floor(epochSeconds / rotationSeconds). A token is accepted for its own window and the one
 * before it (grace for scan latency), so a photographed code goes stale within ~2 rotations.
 */
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const sign = (data: string) => crypto.createHmac('sha256', env.QR_TOKEN_SECRET).update(data).digest('base64url').slice(0, 32);

export const windowOf = (rotationSeconds: number, nowMs = Date.now()) => Math.floor(nowMs / 1000 / rotationSeconds);

export function makeQrToken(qrSessionId: string, rotationSeconds: number, nowMs = Date.now()) {
  const w = windowOf(rotationSeconds, nowMs);
  const payload = b64(JSON.stringify({ q: qrSessionId, w }));
  const secondsLeft = rotationSeconds - (Math.floor(nowMs / 1000) % rotationSeconds);
  return { token: `${payload}.${sign(payload)}`, window: w, secondsLeft };
}

export type QrVerify = { ok: true; qrSessionId: string; window: number } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function parseQrToken(token: string): { ok: true; qrSessionId: string; window: number } | { ok: false; reason: 'malformed' | 'bad_signature' } {
  const [payload, sig] = token.split('.');
  if (!payload || !sig || token.length > 300) return { ok: false, reason: 'malformed' };
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { ok: false, reason: 'bad_signature' };
  try {
    const { q, w } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof q !== 'string' || typeof w !== 'number') return { ok: false, reason: 'malformed' };
    return { ok: true, qrSessionId: q, window: w };
  } catch { return { ok: false, reason: 'malformed' }; }
}

export function isFresh(window: number, rotationSeconds: number, nowMs = Date.now()) {
  const cur = windowOf(rotationSeconds, nowMs);
  return window === cur || window === cur - 1;
}

export const hashIp = (ip: string | undefined) => (ip ? crypto.createHmac('sha256', env.QR_TOKEN_SECRET).update('ip:' + ip).digest('hex').slice(0, 24) : null);
