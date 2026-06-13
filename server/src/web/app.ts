import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import type Database from 'better-sqlite3';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  type AuthOkResponse,
  type AuthStatusResponse,
  type ChangePasswordRequest,
  type HealthResponse,
  type LoginRequest,
  type PlaidStatusResponse,
  type PutIdleExpiryRequest,
  type PutPlaidCredentialsRequest,
  type PutPollingIntervalRequest,
  type PutSettingRequest,
  type SettingResponse,
  type SettingsResponse,
  type SetupRequest,
  type VersionResponse,
} from '@tyche/shared';
import {
  getPollingIntervalHours,
  getSetting,
  MAX_POLLING_INTERVAL_HOURS,
  MIN_POLLING_INTERVAL_HOURS,
  POLLING_INTERVAL_SETTING_KEY,
  setPollingIntervalHours,
  setSetting,
} from '../admin/settings.js';
import {
  clearPlaidCredentials,
  getPlaidCredentialsStatus,
  setPlaidCredentials,
} from '../admin/plaid.js';
import {
  changePassword,
  createLoginRateLimiter,
  createSession,
  createUser,
  destroyOtherSessions,
  destroySession,
  idleExpiryDays,
  IDLE_EXPIRY_SETTING_KEY,
  userExists,
  validateSession,
  verifyLogin,
} from '../auth/index.js';
import { registerLedgerRoutes } from './ledger-routes.js';
import { registerBudgetRoutes } from './budget-routes.js';
import { registerCategoryRoutes } from './category-routes.js';
import { registerImportRoutes } from './import-routes.js';
import { registerMigrationRoutes } from './migration-routes.js';
import { registerPlaidRoutes } from './plaid-routes.js';
import { registerAdminRoutes } from './admin-routes.js';
import type { PlaidSyncGate } from './plaid-scheduler.js';
import type { PlaidClientFactory } from '../importing/index.js';
import type { ConsistencyCheckResponse } from '@tyche/shared';

/**
 * web module (ADR-001): the HTTP layer. REST routes under /api plus, in
 * production, the self-hosted SPA bundle (NFR-2 — zero third-party origins).
 *
 * Auth (E1.S2, FR-33, ADR-008): a single global onRequest hook walls off EVERY
 * /api route behind a valid session — new routes are protected by default.
 * The ONLY exceptions are the explicit allowlist below (health, auth status,
 * login, first-run setup). CSRF: mutating /api requests additionally require
 * the custom header (SameSite=Lax + custom-header scheme, AC-6).
 */

export interface AppOptions {
  db: Database.Database;
  version: string;
  /** Absolute path to the built SPA (web/dist). Omit in tests/dev. */
  spaDir?: string;
  /** Injectable clock for session expiry and lockout tests. Defaults to wall time. */
  now?: () => Date;
  /**
   * 256-bit field-encryption key (ADR-007), loaded from MASTER_KEY in .env by
   * the boot sequence — which fails hard when it is missing/malformed. Only
   * tests omit it; secret-bearing routes then answer 503.
   */
  masterKey?: Buffer;
  /** Capture-stream for log output (NFR-3 log-grep tests). Forces logging ON. */
  logSink?: { write(line: string): unknown };
  /**
   * The Plaid client seam (E5, ADR-006): tests inject a fake PlaidClientPort
   * factory here; production defaults to the official-SDK adapter. The suite
   * never reaches Plaid's network.
   */
  plaidClientFactory?: PlaidClientFactory;
  /**
   * Per-Item single-flight gate (E5.S3 AC-6), shared between the manual-sync
   * route and the polling scheduler. index.ts creates ONE gate and hands it
   * to both; when omitted (tests without a scheduler) the routes make their
   * own. The scheduler itself is wired in index.ts, never here — buildApp
   * stays timer-free for tests.
   */
  plaidSyncGate?: PlaidSyncGate;
  /**
   * Backup artifacts directory (E7.S1). Defaults to `backups/` beside the
   * SQLite file; undefined for :memory: databases (routes answer 503).
   */
  backupsDir?: string;
  /** Boot-time NFR-12 consistency result (E7.S4 AC-2), from runStartupSequence. */
  bootConsistency?: ConsistencyCheckResponse | null;
}

/**
 * Logger redaction layer (AC-3 of E1.S3, ADR-007 / NFR-3): deny-list of
 * secret-bearing fields censored on EVERY log line, error paths included.
 * Covers today's secrets (Plaid client secret, passwords) and E5's access
 * tokens, plus the session cookie so log files can't be replayed as auth.
 */
const SECRET_FIELDS = [
  'secret',
  'clientSecret',
  'client_secret',
  'password',
  'currentPassword',
  'newPassword',
  'masterKey',
  'accessToken',
  'access_token',
];
const REDACT_PATHS = [
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((f) => `*.${f}`),
  ...SECRET_FIELDS.map((f) => `body.${f}`),
  'req.headers.cookie',
  'req.headers.authorization',
];

/** Method + path pairs reachable WITHOUT a session. Everything else under /api is walled. */
const SESSION_EXEMPT = new Set([
  'GET /api/health',
  'GET /api/auth/status',
  'POST /api/auth/login',
  'POST /api/auth/setup',
]);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Keys owned by dedicated validated endpoints — the generic KV route must not
 * write them, or it would bypass their range checks (NFR-10).
 */
const MANAGED_SETTING_KEYS = new Set<string>([IDLE_EXPIRY_SETTING_KEY, POLLING_INTERVAL_SETTING_KEY]);

const PASSWORD_BODY_SCHEMA = {
  body: {
    type: 'object',
    required: ['password'],
    properties: { password: { type: 'string', minLength: 8, maxLength: 512 } },
    additionalProperties: false,
  },
} as const;

export function buildApp({
  db,
  version,
  spaDir,
  now = () => new Date(),
  masterKey,
  logSink,
  plaidClientFactory,
  plaidSyncGate,
  backupsDir,
  bootConsistency = null,
}: AppOptions): FastifyInstance {
  const redact = { paths: REDACT_PATHS, censor: '[redacted]' };
  const app = Fastify({
    logger: logSink
      ? { level: 'info', stream: logSink, redact }
      : process.env['NODE_ENV'] === 'test'
        ? false
        : { redact },
    // Deployment model (AS-2/NFR-10): directly on LAN or behind a single
    // trusted TLS-terminating proxy — honour x-forwarded-proto so the session
    // cookie gets its Secure flag when TLS terminates upstream (ADR-008).
    trustProxy: true,
  });
  const loginLimiter = createLoginRateLimiter();

  void app.register(fastifyCookie);
  // File-import uploads (E4.S1, FR-24). RBC's ~90-day exports are a few hundred
  // KB at most; 10 MB is a generous ceiling, not a target. files: 2 because the
  // YNAB migration (E6) uploads its Register + Plan CSVs in one request.
  void app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024, files: 2 } });

  const setSessionCookie = (req: FastifyRequest, reply: FastifyReply, sessionId: string): void => {
    reply.setCookie(SESSION_COOKIE, sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https', // secure-when-https (ADR-008; TLS is the proxy's job)
    });
  };

  // --- The session wall (AC-2) + CSRF check (AC-6), one global hook. -------
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (!path.startsWith('/api/')) return; // SPA shell/assets — the data lives behind /api

    // CSRF: every mutation needs the custom header, allowlisted or not.
    if (MUTATING_METHODS.has(req.method) && req.headers[CSRF_HEADER] === undefined) {
      return reply.code(403).send({ error: 'csrf_header_required' });
    }

    if (SESSION_EXEMPT.has(`${req.method} ${path}`)) return;

    const sessionId = req.cookies[SESSION_COOKIE];
    if (!sessionId || !validateSession(db, sessionId, now())) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // --- Auth routes (E1.S2) --------------------------------------------------

  app.get('/api/auth/status', async (req): Promise<AuthStatusResponse> => {
    const sessionId = req.cookies[SESSION_COOKIE];
    return {
      setupRequired: !userExists(db),
      authenticated: sessionId !== undefined && validateSession(db, sessionId, now()),
    };
  });

  app.post<{ Body: SetupRequest }>(
    '/api/auth/setup',
    { schema: PASSWORD_BODY_SCHEMA },
    async (req, reply): Promise<AuthOkResponse> => {
      if (userExists(db)) {
        // AC-1: permanently unavailable once the single account exists.
        return reply.code(410).send({ error: 'setup_already_complete' });
      }
      try {
        await createUser(db, req.body.password);
      } catch (err) {
        // Two concurrent first-run setups: the schema (id=1 PK) lets exactly
        // one win; the loser gets the same 410 as any post-setup attempt.
        if (userExists(db)) {
          return reply.code(410).send({ error: 'setup_already_complete' });
        }
        throw err;
      }
      setSessionCookie(req, reply, createSession(db, now()));
      return { ok: true };
    },
  );

  app.post<{ Body: LoginRequest }>(
    '/api/auth/login',
    { schema: PASSWORD_BODY_SCHEMA },
    async (req, reply): Promise<AuthOkResponse> => {
      // AC-4: while locked out, refuse regardless of password correctness.
      if (loginLimiter.isLockedOut(now())) {
        const retryAfter = loginLimiter.retryAfterSeconds(now());
        return reply
          .code(429)
          .header('retry-after', String(retryAfter))
          .send({ error: 'locked_out', retryAfterSeconds: retryAfter });
      }
      if (!(await verifyLogin(db, req.body.password))) {
        loginLimiter.recordFailure(now());
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      loginLimiter.reset();
      setSessionCookie(req, reply, createSession(db, now()));
      return { ok: true };
    },
  );

  app.post('/api/auth/logout', async (req, reply): Promise<AuthOkResponse> => {
    const sessionId = req.cookies[SESSION_COOKIE];
    if (sessionId) destroySession(db, sessionId); // revoke server-side (Dev Notes)
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post<{ Body: ChangePasswordRequest }>(
    '/api/auth/change-password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 512 },
            newPassword: { type: 'string', minLength: 8, maxLength: 512 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<AuthOkResponse> => {
      // AC-5: the current password gates the change.
      if (!(await changePassword(db, req.body.currentPassword, req.body.newPassword))) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      // AC-5: every OTHER session is revoked; the one making the change lives on.
      destroyOtherSessions(db, req.cookies[SESSION_COOKIE] ?? '');
      return { ok: true };
    },
  );

  // --- Settings surface (E1.S3, FR-34) --------------------------------------

  const settingsResponse = (): SettingsResponse => ({
    plaid: getPlaidCredentialsStatus(db),
    pollingIntervalHours: getPollingIntervalHours(db),
    sessionIdleExpiryDays: idleExpiryDays(db),
  });

  app.get('/api/settings', async (): Promise<SettingsResponse> => settingsResponse());

  // Plaid credentials: the secret goes in, gets encrypted (ADR-007), and NEVER
  // comes back out — responses carry only the configured flag + client id.
  app.put<{ Body: PutPlaidCredentialsRequest }>(
    '/api/settings/plaid',
    {
      schema: {
        body: {
          type: 'object',
          required: ['clientId', 'secret'],
          properties: {
            clientId: { type: 'string', minLength: 1, maxLength: 256 },
            secret: { type: 'string', minLength: 1, maxLength: 256 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<PlaidStatusResponse> => {
      if (!masterKey) {
        return reply.code(503).send({ error: 'encryption_unavailable' });
      }
      setPlaidCredentials(db, masterKey, req.body.clientId, req.body.secret);
      return getPlaidCredentialsStatus(db);
    },
  );

  app.delete('/api/settings/plaid', async (): Promise<PlaidStatusResponse> => {
    clearPlaidCredentials(db);
    return getPlaidCredentialsStatus(db);
  });

  app.put<{ Body: PutPollingIntervalRequest }>(
    '/api/settings/polling-interval',
    {
      schema: {
        body: {
          type: 'object',
          required: ['hours'],
          properties: {
            hours: {
              type: 'integer',
              minimum: MIN_POLLING_INTERVAL_HOURS,
              maximum: MAX_POLLING_INTERVAL_HOURS,
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (req): Promise<SettingsResponse> => {
      setPollingIntervalHours(db, req.body.hours);
      return settingsResponse();
    },
  );

  // AC-7: owned here, consumed by the auth module's session validation (E1.S2).
  app.put<{ Body: PutIdleExpiryRequest }>(
    '/api/settings/session-idle-expiry',
    {
      schema: {
        body: {
          type: 'object',
          required: ['days'],
          properties: { days: { type: 'integer', minimum: 1, maximum: 365 } },
          additionalProperties: false,
        },
      },
    },
    async (req): Promise<SettingsResponse> => {
      setSetting(db, IDLE_EXPIRY_SETTING_KEY, String(req.body.days));
      return settingsResponse();
    },
  );

  // --- Ledger surface (E2.S1–S3): accounts, register, transactions, payees --
  registerLedgerRoutes(app, db);

  // --- Budget surface (E3.S1): month grid payload + assignments -------------
  registerBudgetRoutes(app, db, now);

  // --- Category & group management (E3.S6, FR-9) ----------------------------
  registerCategoryRoutes(app, db);

  // --- File import + review queue (E4.S1–S3, FR-22..25) ---------------------
  registerImportRoutes(app, db);

  // --- YNAB migration (E6, FR-30/31) -----------------------------------------
  registerMigrationRoutes(app, db);

  // --- Plaid link + sync (E5.S1–S2, FR-20/21/27) -----------------------------
  registerPlaidRoutes(app, db, {
    masterKey,
    ...(plaidClientFactory ? { clientFactory: plaidClientFactory } : {}),
    ...(plaidSyncGate ? { syncGate: plaidSyncGate } : {}),
  });

  // --- Ops: backup, CSV export, consistency check (E7, FR-35/36, NFR-12) -----
  registerAdminRoutes(app, db, {
    backupsDir:
      backupsDir ?? (db.name && db.name !== ':memory:' ? join(dirname(db.name), 'backups') : undefined),
    bootConsistency,
    appVersion: version,
    now,
  });

  // --- E1.S1 surface (now behind the wall except /api/health) --------------

  app.get('/api/health', async (): Promise<HealthResponse> => {
    db.prepare('SELECT 1').get(); // proves the DB file is open and readable
    return { status: 'ok', database: 'ok' };
  });

  app.get('/api/version', async (): Promise<VersionResponse> => ({ version }));

  app.put<{ Params: { key: string }; Body: PutSettingRequest }>(
    '/api/settings/:key',
    {
      schema: {
        body: {
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<SettingResponse> => {
      if (MANAGED_SETTING_KEYS.has(req.params.key)) {
        return reply.code(400).send({ error: 'managed_setting_use_dedicated_endpoint' });
      }
      return setSetting(db, req.params.key, req.body.value);
    },
  );

  app.get<{ Params: { key: string } }>('/api/settings/:key', async (req, reply) => {
    const setting = getSetting(db, req.params.key);
    if (!setting) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return setting satisfies SettingResponse;
  });

  if (spaDir && existsSync(spaDir)) {
    void app.register(fastifyStatic, { root: spaDir });
    // SPA fallback: any non-API GET serves index.html (client-side routing).
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));
  }

  return app;
}
