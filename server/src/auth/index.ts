/**
 * auth module (ADR-001, ADR-008): single-account credentials (argon2id),
 * SQLite-backed sessions with settings-driven idle expiry, and the in-process
 * login rate limiter (FR-33, NFR-10 — E1.S2). This file is the module's
 * public interface; other modules import from here.
 */
export { changePassword, createUser, userExists, verifyLogin } from './credentials.js';
export {
  createSession,
  destroyOtherSessions,
  destroySession,
  validateSession,
  idleExpiryDays,
  IDLE_EXPIRY_SETTING_KEY,
  DEFAULT_IDLE_EXPIRY_DAYS,
} from './sessions.js';
export { createLoginRateLimiter, type LoginRateLimiter } from './rate-limit.js';
