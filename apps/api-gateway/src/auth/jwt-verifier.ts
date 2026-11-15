import { jwtVerify } from 'jose';
import { Inject, Injectable } from '@nestjs/common';
import { GATEWAY_CLOCK, GATEWAY_CONFIG, type JwtConfig, type Role } from '../config/gateway-config.js';
import { InvalidTokenError } from '../http/errors.js';

export interface VerifiedIdentity {
  readonly sub: string;
  readonly role: Role;
  readonly exp: number;
}

@Injectable()
export class JwtVerifier {
  private readonly key: Uint8Array;

  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: JwtConfig,
    @Inject(GATEWAY_CLOCK) private readonly now: () => number = Date.now,
  ) {
    this.key = new TextEncoder().encode(config.secret);
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    if (token.length === 0 || token.length > 8_192) throw new InvalidTokenError();

    let payload: Record<string, unknown>;
    let algorithm: string | undefined;
    try {
      const result = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: this.config.issuer,
        audience: this.config.audience,
        currentDate: new Date(this.now()),
        clockTolerance: 0,
      });
      payload = result.payload;
      algorithm = result.protectedHeader.alg;
    } catch {
      throw new InvalidTokenError();
    }

    if (algorithm !== 'HS256') throw new InvalidTokenError();
    if (payload.iss !== this.config.issuer) throw new InvalidTokenError();
    if (payload.aud !== this.config.audience) throw new InvalidTokenError();
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub !== payload.sub.trim()) {
      throw new InvalidTokenError();
    }
    if (payload.role !== 'reader' && payload.role !== 'operator') {
      throw new InvalidTokenError();
    }
    if (!Number.isSafeInteger(payload.exp)) throw new InvalidTokenError();
    const exp = payload.exp as number;
    if (exp <= Math.floor(this.now() / 1_000)) throw new InvalidTokenError();

    return { sub: payload.sub, role: payload.role, exp };
  }
}
