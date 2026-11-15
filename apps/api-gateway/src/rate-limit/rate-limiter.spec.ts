import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('rate limiter', () => {
  it('allows the configured quota and rejects the next request', () => {
    let now = 1_800_000_000_000;
    const limiter = new RateLimiter(60_000, 2, 10, () => now);
    expect(limiter.check('reader-1')).toEqual({ allowed: true });
    expect(limiter.check('reader-1')).toEqual({ allowed: true });
    expect(limiter.check('reader-1')).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
  });

  it('shares quota by subject, not by token', () => {
    const now = 1_800_000_000_000;
    const limiter = new RateLimiter(60_000, 1, 10, () => now);
    expect(limiter.check('same-sub')).toEqual({ allowed: true });
    expect(limiter.check('same-sub')).toMatchObject({ allowed: false });
    expect(limiter.check('other-sub')).toEqual({ allowed: true });
  });

  it('resets at the fixed epoch window and reports the real remaining time', () => {
    let now = 1_800_000_015_000;
    const limiter = new RateLimiter(60_000, 1, 10, () => now);
    expect(limiter.check('reader-1')).toEqual({ allowed: true });
    expect(limiter.check('reader-1')).toMatchObject({ allowed: false, retryAfterSeconds: 45 });

    now += 15_000;
    expect(limiter.check('reader-1')).toMatchObject({ allowed: false, retryAfterSeconds: 30 });

    now += 30_000;
    expect(limiter.check('reader-1')).toEqual({ allowed: true });
  });

  it('does not evict an active identity when the identity cap is reached', () => {
    let now = 1_800_000_000_000;
    const limiter = new RateLimiter(60_000, 10, 2, () => now);
    expect(limiter.check('a')).toEqual({ allowed: true });
    expect(limiter.check('b')).toEqual({ allowed: true });
    expect(limiter.check('c')).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.check('a')).toEqual({ allowed: true });
    expect(limiter.identityCount).toBe(2);

    now += 60_000;
    expect(limiter.check('c')).toEqual({ allowed: true });
  });

  it('cleans expired identities before applying the cap', () => {
    let now = 1_800_000_000_000;
    const limiter = new RateLimiter(60_000, 10, 2, () => now);
    limiter.check('a');
    limiter.check('b');
    now += 60_000;
    expect(limiter.check('c')).toEqual({ allowed: true });
    expect(limiter.identityCount).toBe(1);
  });

  it('allows exactly the limit under concurrent checks', async () => {
    const now = 1_800_000_000_000;
    const limiter = new RateLimiter(60_000, 60, 10, () => now);
    const results = await Promise.all(
      Array.from({ length: 100 }, async () => limiter.check('reader-1')),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(60);
    expect(results.filter((result) => !result.allowed)).toHaveLength(40);
  });
});
