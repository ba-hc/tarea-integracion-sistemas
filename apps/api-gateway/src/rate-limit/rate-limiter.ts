export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

interface WindowEntry {
  windowStart: number;
  count: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
    private readonly maxIdentities: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(subject: string): RateLimitDecision {
    const now = this.now();
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    const existing = this.entries.get(subject);

    if (existing !== undefined) {
      if (existing.windowStart !== windowStart) {
        existing.windowStart = windowStart;
        existing.count = 0;
      }
      if (existing.count >= this.maxRequests) {
        return { allowed: false, retryAfterSeconds: this.retryAfter(now, windowStart) };
      }
      existing.count += 1;
      return { allowed: true };
    }

    this.cleanup(now);
    if (this.entries.size >= this.maxIdentities) {
      return { allowed: false, retryAfterSeconds: this.oldestRetryAfter(now) };
    }

    this.entries.set(subject, { windowStart, count: 1 });
    return { allowed: true };
  }

  get identityCount(): number {
    return this.entries.size;
  }

  private cleanup(now: number): void {
    for (const [subject, entry] of this.entries) {
      if (entry.windowStart + this.windowMs <= now) this.entries.delete(subject);
    }
  }

  private retryAfter(now: number, windowStart: number): number {
    return Math.max(1, Math.ceil((windowStart + this.windowMs - now) / 1_000));
  }

  private oldestRetryAfter(now: number): number {
    let oldest = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      oldest = Math.min(oldest, entry.windowStart);
    }
    if (!Number.isFinite(oldest)) return 1;
    return this.retryAfter(now, oldest);
  }
}
