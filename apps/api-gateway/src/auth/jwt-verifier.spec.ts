import { describe, expect, it } from 'vitest';
import { SignJWT, decodeJwt, generateKeyPair } from 'jose';
import type { JwtConfig } from '../config/gateway-config.js';
import { signDemoToken } from './sign-demo-token.js';
import { JwtVerifier } from './jwt-verifier.js';
import { parseBearer } from './bearer.js';

const CONFIG: JwtConfig = {
  secret: 'test-secret-with-at-least-32-bytes!!',
  issuer: 'repuestossur-demo',
  audience: 'repuestossur-gateway',
};
const NOW = 1_800_000_000_000;
const clock = (): number => NOW;

function verifier(config: JwtConfig = CONFIG): JwtVerifier {
  return new JwtVerifier(config, clock);
}

async function rawToken(
  payload: Record<string, unknown>,
  options: { secret?: string; issuer?: string; audience?: string; alg?: 'HS256' | 'HS512' } = {},
): Promise<string> {
  const secret = new TextEncoder().encode(options.secret ?? CONFIG.secret);
  const issuer = options.issuer ?? CONFIG.issuer;
  const audience = options.audience ?? CONFIG.audience;
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: options.alg ?? 'HS256', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .sign(secret);
}

describe('JWT verifier', () => {
  it('accepts a valid reader token and returns the identity', async () => {
    const token = await signDemoToken(CONFIG, {
      sub: 'reader-1',
      role: 'reader',
      nowSeconds: NOW / 1_000,
    });
    await expect(verifier().verify(token)).resolves.toMatchObject({
      sub: 'reader-1',
      role: 'reader',
    });
  });

  it('accepts a valid operator token', async () => {
    const token = await signDemoToken(CONFIG, {
      sub: 'operator-1',
      role: 'operator',
      nowSeconds: NOW / 1_000,
    });
    await expect(verifier().verify(token)).resolves.toMatchObject({ role: 'operator' });
  });

  it('rejects an invalid signature', async () => {
    const token = await signDemoToken({ ...CONFIG, secret: 'y'.repeat(32) }, {
      sub: 'reader-1',
      role: 'reader',
      nowSeconds: NOW / 1_000,
    });
    await expect(verifier().verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an expired token', async () => {
    const token = await signDemoToken(CONFIG, {
      sub: 'reader-1',
      role: 'reader',
      ttlMinutes: 1,
      nowSeconds: NOW / 1_000 - 120,
    });
    await expect(verifier().verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token without exp', async () => {
    const token = await rawToken({ sub: 'reader-1', role: 'reader' });
    await expect(verifier().verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects non-integer exp', async () => {
    const token = await rawToken({ sub: 'reader-1', role: 'reader', exp: '9999999999' });
    await expect(verifier().verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it.each([
    ['issuer', { issuer: 'other' }],
    ['audience', { audience: 'other' }],
  ])('rejects the wrong %s', async (_label, options) => {
    const token = await rawToken(
      { sub: 'reader-1', role: 'reader', exp: NOW / 1_000 + 900 },
      options,
    );
    await expect(verifier().verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an audience array even when it contains the expected value', async () => {
    const token = await new SignJWT({ sub: 'reader-1', role: 'reader' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(CONFIG.issuer)
      .setAudience([CONFIG.audience])
      .setExpirationTime(NOW / 1_000 + 900)
      .sign(new TextEncoder().encode(CONFIG.secret));
    await expect(verifier().verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it.each([
    [{ sub: '', role: 'reader' }],
    [{ sub: 7, role: 'reader' }],
    [{ sub: 'reader-1', role: 'admin' }],
    [{ sub: 'reader-1', role: ['reader'] }],
    [{ sub: 'reader-1' }],
  ])('rejects invalid sub/role claims', async (payload) => {
    const token = await rawToken({ ...payload, exp: NOW / 1_000 + 900 });
    await expect(verifier().verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a signed token whose sub has leading or trailing whitespace', async () => {
    const token = await rawToken({
      sub: ' padded-sub ',
      role: 'reader',
      exp: NOW / 1_000 + 900,
    });
    await expect(verifier().verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects HS512, RS256 and alg:none', async () => {
    const hs512 = await rawToken(
      { sub: 'reader-1', role: 'reader', exp: NOW / 1_000 + 900 },
      { alg: 'HS512' },
    );
    await expect(verifier().verify(hs512)).rejects.toMatchObject({ status: 401 });

    const { privateKey } = await generateKeyPair('RS256');
    const rs256 = await new SignJWT({ sub: 'reader-1', role: 'reader' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(CONFIG.issuer)
      .setAudience(CONFIG.audience)
      .setExpirationTime(NOW / 1_000 + 900)
      .sign(privateKey);
    await expect(verifier().verify(rs256)).rejects.toMatchObject({ status: 401 });

    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const none = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: 'reader-1',
      role: 'reader',
      iss: CONFIG.issuer,
      aud: CONFIG.audience,
      exp: NOW / 1_000 + 900,
    })}.`;
    await expect(verifier().verify(none)).rejects.toMatchObject({ status: 401 });
  });

  it('issues 15-minute tokens by default', async () => {
    const token = await signDemoToken(CONFIG, {
      sub: 'reader-1',
      role: 'reader',
      nowSeconds: NOW / 1_000,
    });
    const payload = decodeJwt(token);
    expect(payload.exp).toBe(NOW / 1_000 + 900);
    expect(payload.iat).toBe(NOW / 1_000);
  });

  it('parses exactly one Bearer credential', () => {
    expect(parseBearer('Bearer a.b.c')).toBe('a.b.c');
    expect(parseBearer('bearer   a.b.c')).toBe('a.b.c');
    expect(parseBearer('Basic a.b.c')).toBeNull();
    expect(parseBearer('Bearer')).toBeNull();
    expect(parseBearer('Bearer a.b.c ')).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });
});
