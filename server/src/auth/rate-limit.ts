/**
 * In-process login rate limiter (NFR-10, AC-4 of E1.S2).
 *
 * Single user, single process (ADR-001) — no Redis, no per-IP keying: ANY
 * 5 consecutive failures lock the login for ≥ 60 s, regardless of password
 * correctness on the next attempt. State is in-memory by design; a restart
 * clears it, which is acceptable for the LAN threat model (AS-2).
 */

export interface LoginRateLimiter {
  /** True while the lockout window is active — refuse the attempt outright. */
  isLockedOut(now: Date): boolean;
  /** Call on every failed login. The 5th (and any later) failure arms/re-arms the lockout. */
  recordFailure(now: Date): void;
  /** Call on successful login: clears the consecutive-failure count. */
  reset(): void;
  /** Whole seconds until the lockout lifts (0 when not locked). */
  retryAfterSeconds(now: Date): number;
}

const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

export function createLoginRateLimiter(): LoginRateLimiter {
  let consecutiveFailures = 0;
  let lockedUntilMs = 0;

  return {
    isLockedOut(now: Date): boolean {
      return now.getTime() < lockedUntilMs;
    },
    recordFailure(now: Date): void {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_FAILURES) {
        lockedUntilMs = now.getTime() + LOCKOUT_MS;
      }
    },
    reset(): void {
      consecutiveFailures = 0;
      lockedUntilMs = 0;
    },
    retryAfterSeconds(now: Date): number {
      return Math.max(0, Math.ceil((lockedUntilMs - now.getTime()) / 1000));
    },
  };
}
