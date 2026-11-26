import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const hashPassword = (pw: string) => bcrypt.hash(pw, 11);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export interface AccessClaims { sub: string; pr?: string | null }
export function signAccessToken(claims: AccessClaims) {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, issuer: 'attendiq', audience: 'attendiq-api' });
}
export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'attendiq', audience: 'attendiq-api' }) as AccessClaims;
}

export const passwordSchemaRules = { min: 10, max: 128 };
export function passwordProblems(pw: string): string | null {
  if (pw.length < passwordSchemaRules.min) return `Password must be at least ${passwordSchemaRules.min} characters`;
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers';
  return null;
}
