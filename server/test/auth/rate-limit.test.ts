import { describe, expect, it } from 'vitest';
import { createLoginRateLimiter } from '../../src/auth/rate-limit.js';

// E1.S2 AC-4 / NFR-10: 5 consecutive failures → login refused for ≥ 60 s
// regardless of password correctness. In-process, injectable clock.

const t = (ms: number): Date => new Date(ms);

describe('login rate limiter', () => {
  it('allows attempts before the 5th consecutive failure', () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < 4; i++) limiter.recordFailure(t(i));
    expect(limiter.isLockedOut(t(5))).toBe(false);
  });

  it('locks out after 5 consecutive failures (AC-4)', () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < 5; i++) limiter.recordFailure(t(i));
    expect(limiter.isLockedOut(t(5))).toBe(true);
  });

  it('the lockout lasts at least 60 seconds from the 5th failure', () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < 5; i++) limiter.recordFailure(t(i));
    expect(limiter.isLockedOut(t(4 + 59_000))).toBe(true);
    expect(limiter.isLockedOut(t(4 + 60_001))).toBe(false);
  });

  it('reports seconds remaining for the Retry-After surface', () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < 5; i++) limiter.recordFailure(t(0));
    expect(limiter.retryAfterSeconds(t(10_000))).toBe(50);
  });

  it('a success resets the consecutive-failure count', () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < 4; i++) limiter.recordFailure(t(i));
    limiter.reset();
    for (let i = 0; i < 4; i++) limiter.recordFailure(t(10 + i));
    expect(limiter.isLockedOut(t(20))).toBe(false);
  });

  it('a failure after an expired lockout re-locks immediately (still consecutive)', () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < 5; i++) limiter.recordFailure(t(i));
    limiter.recordFailure(t(70_000)); // 6th consecutive failure, after lockout lapsed
    expect(limiter.isLockedOut(t(70_001))).toBe(true);
  });
});
