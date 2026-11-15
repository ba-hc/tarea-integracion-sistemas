import { SignJWT } from 'jose';
import type { JwtConfig, Role } from '../config/gateway-config.js';

export interface DemoTokenOptions {
  readonly sub: string;
  readonly role: Role;
  readonly ttlMinutes?: number;
  readonly nowSeconds?: number;
}

export async function signDemoToken(config: JwtConfig, options: DemoTokenOptions): Promise<string> {
  const sub = options.sub.trim();
  if (!sub) throw new Error('sub must not be empty');
  if (options.role !== 'reader' && options.role !== 'operator') {
    throw new Error('role must be reader or operator');
  }

  const ttlMinutes = options.ttlMinutes ?? 15;
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1) {
    throw new Error('ttlMinutes must be a positive integer');
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(nowSeconds)) throw new Error('nowSeconds must be a safe integer');
  const expiresAt = nowSeconds + ttlMinutes * 60;
  if (!Number.isSafeInteger(expiresAt)) throw new Error('token expiration is out of range');
  const key = new TextEncoder().encode(config.secret);
  return await new SignJWT({ role: options.role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setSubject(sub)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAt)
    .sign(key);
}
