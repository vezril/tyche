import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import type {
  CreatePlaidItemRequest,
  PlaidItemResponse,
  PlaidItemsResponse,
  PlaidLinkedAccountResponse,
  PlaidLinkTokenResponse,
  PlaidSyncRunResponse,
  PutPlaidMappingsRequest,
} from '@tyche/shared';
import { getPlaidCredentialsStatus, getPlaidEnvironment, getPlaidSecret } from '../admin/plaid.js';
import { getAccountRow } from '../ledger/index.js';
import {
  applyAccountMappings,
  completeRelink,
  createLinkedItem,
  createPlaidSdkClient,
  getAccessToken,
  getPlaidItem,
  ImportError,
  lastSuccessfulSyncAt,
  listAccountLinks,
  listPlaidItems,
  listSyncLog,
  PlaidApiError,
  syncPlaidItem,
  unlinkPlaidItem,
  type PlaidClientFactory,
  type PlaidClientPort,
  type PlaidItemRecord,
} from '../importing/index.js';
import { balancesOf, sendImportError } from './import-routes.js';
import { PlaidSyncGate } from './plaid-scheduler.js';

/**
 * Plaid link + sync HTTP surface (E5.S1/S2, FR-20/21/27). Translation layer
 * only: credentials are resolved HERE (admin module — importing may not
 * import admin per ADR-001) and handed to the importing module's client
 * factory; link/mapping/sync semantics live in importing/plaid/. All routes
 * sit behind the session wall + CSRF hook in app.ts by construction.
 *
 * The factory is injectable (tests pass a fake; production uses the official
 * SDK adapter) — the suite never talks to Plaid (ADR-006 test seam).
 */

export interface PlaidRouteOptions {
  masterKey?: Buffer | undefined;
  clientFactory?: PlaidClientFactory;
  env?: Record<string, string | undefined>;
  /**
   * Per-Item single-flight gate shared with the E5.S3 scheduler (AC-6): a
   * manual "sync now" while a scheduled run is in flight joins that run
   * instead of double-syncing. index.ts passes the scheduler's gate.
   */
  syncGate?: PlaidSyncGate;
}

export function registerPlaidRoutes(
  app: FastifyInstance,
  db: Database.Database,
  {
    masterKey,
    clientFactory = createPlaidSdkClient,
    env = process.env,
    syncGate = new PlaidSyncGate(),
  }: PlaidRouteOptions,
): void {
  /** Resolve stored credentials → a Plaid client, or fail with the right status. */
  const requireClient = (reply: FastifyReply): PlaidClientPort | null => {
    if (!masterKey) {
      void reply.code(503).send({ error: 'encryption_unavailable' });
      return null;
    }
    const status = getPlaidCredentialsStatus(db);
    const secret = status.configured ? getPlaidSecret(db, masterKey) : undefined;
    if (!status.configured || status.clientId === null || secret === undefined) {
      void reply.code(400).send({ error: 'plaid_not_configured' });
      return null;
    }
    return clientFactory({
      clientId: status.clientId,
      secret,
      environment: getPlaidEnvironment(db, env),
    });
  };

  const accountName = (accountId: string | null): string | null => {
    if (accountId === null) return null;
    try {
      return getAccountRow(db, accountId).name;
    } catch {
      return null; // mapping survived an account we can no longer resolve
    }
  };

  const itemResponse = (item: PlaidItemRecord): PlaidItemResponse => {
    const syncLog = listSyncLog(db, item.id);
    return {
      id: item.id,
      institutionName: item.institutionName,
      status: item.status,
      accounts: listAccountLinks(db, item.id).map(
        (link): PlaidLinkedAccountResponse => ({
          plaidAccountId: link.plaidAccountId,
          name: link.name,
          mask: link.mask,
          type: link.type,
          subtype: link.subtype,
          accountId: link.accountId,
          accountName: accountName(link.accountId),
          skipped: link.skipped,
        }),
      ),
      lastAttempt: syncLog[0] ?? null,
      lastSuccessAt: lastSuccessfulSyncAt(db, item.id),
      syncLog,
    };
  };

  /** PlaidApiError → 502 with the upstream code; domain errors → their status. */
  const sendPlaidError = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof PlaidApiError) {
      return reply.code(502).send({ error: 'plaid_api_error', plaidCode: err.plaidCode });
    }
    return sendImportError(reply, err);
  };

  // --- S1 AC-1: link token for the Link widget ------------------------------
  app.post('/api/plaid/link-token', async (req, reply): Promise<PlaidLinkTokenResponse> => {
    const client = requireClient(reply);
    if (!client) return reply as never;
    try {
      return { linkToken: await client.createLinkToken() };
    } catch (err) {
      return sendPlaidError(reply, err) as never;
    }
  });

  // --- S1 AC-2: public-token exchange → encrypted Item in LINKING ------------
  app.post<{ Body: CreatePlaidItemRequest }>(
    '/api/plaid/items',
    {
      schema: {
        body: {
          type: 'object',
          required: ['publicToken'],
          properties: { publicToken: { type: 'string', minLength: 1, maxLength: 512 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<PlaidItemResponse> => {
      const client = requireClient(reply);
      if (!client) return reply as never;
      try {
        const exchanged = await client.exchangePublicToken(req.body.publicToken);
        const discovered = await client.getItemAccounts(exchanged.accessToken);
        const item = createLinkedItem(db, masterKey!, {
          plaidItemId: exchanged.plaidItemId,
          accessToken: exchanged.accessToken,
          institutionName: discovered.institutionName,
          accounts: discovered.accounts,
        });
        return reply.code(201).send(itemResponse(item)) as never;
      } catch (err) {
        return sendPlaidError(reply, err) as never;
      }
    },
  );

  // --- S1 AC-5: the connections screen's data ---------------------------------
  app.get('/api/plaid/items', async (): Promise<PlaidItemsResponse> => ({
    items: listPlaidItems(db).map(itemResponse),
  }));

  // --- S1 AC-3: per-account mapping decisions (map / skip), Item → ACTIVE ----
  app.put<{ Params: { id: string }; Body: PutPlaidMappingsRequest }>(
    '/api/plaid/items/:id/mappings',
    {
      schema: {
        body: {
          type: 'object',
          required: ['mappings'],
          properties: {
            mappings: {
              type: 'array',
              items: {
                type: 'object',
                required: ['plaidAccountId', 'accountId', 'skipped'],
                properties: {
                  plaidAccountId: { type: 'string', minLength: 1 },
                  accountId: { type: ['string', 'null'] },
                  skipped: { type: 'boolean' },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply): Promise<PlaidItemResponse> => {
      try {
        applyAccountMappings(db, req.params.id, req.body.mappings);
        return itemResponse(getPlaidItem(db, req.params.id));
      } catch (err) {
        return sendImportError(reply, err) as never;
      }
    },
  );

  // --- S2: manual "sync now" (FR-21; the S3 scheduler calls syncPlaidItem too)
  app.post<{ Params: { id: string } }>(
    '/api/plaid/items/:id/sync',
    async (req, reply): Promise<PlaidSyncRunResponse> => {
      const client = requireClient(reply);
      if (!client) return reply as never;
      try {
        // Single-flight per Item (S3 AC-6): if a scheduled poll already has
        // this Item in flight, this request joins it and returns its result.
        const result = await syncGate.run(req.params.id, () =>
          syncPlaidItem(db, masterKey!, client, req.params.id),
        );
        return {
          itemId: result.itemId,
          addedCount: result.addedCount,
          mergedCount: result.mergedCount,
          updatedCount: result.updatedCount,
          removedVoidedCount: result.removedVoidedCount,
          removedFlaggedCount: result.removedFlaggedCount,
          duplicateCount: result.duplicateCount,
          ignoredUnmappedCount: result.ignoredUnmappedCount,
          errors: result.errors,
          accountBalances: balancesOf(db, result.accountIds),
        };
      } catch (err) {
        return sendPlaidError(reply, err) as never;
      }
    },
  );

  // --- S4: Link UPDATE-MODE token for a broken connection (FR-26) ------------
  // The token is created against the Item's stored access token, so Link
  // re-authenticates the SAME Item — cursor and mappings preserved.
  app.post<{ Params: { id: string } }>(
    '/api/plaid/items/:id/relink-token',
    async (req, reply): Promise<PlaidLinkTokenResponse> => {
      const client = requireClient(reply);
      if (!client) return reply as never;
      try {
        const item = getPlaidItem(db, req.params.id);
        if (item.status !== 'NEEDS_RELINK' && item.status !== 'ACTIVE') {
          throw new ImportError('plaid_item_not_active');
        }
        const accessToken = getAccessToken(db, masterKey!, req.params.id);
        return { linkToken: await client.createUpdateLinkToken(accessToken) };
      } catch (err) {
        return sendPlaidError(reply, err) as never;
      }
    },
  );

  // --- S4 AC-2: update mode completed → NEEDS_RELINK back to ACTIVE ----------
  // Update mode keeps the existing access-token grant (nothing to exchange);
  // the banner clears and the next sync resumes from the preserved cursor.
  app.post<{ Params: { id: string } }>(
    '/api/plaid/items/:id/relinked',
    async (req, reply): Promise<PlaidItemResponse> => {
      try {
        return itemResponse(completeRelink(db, req.params.id));
      } catch (err) {
        return sendImportError(reply, err) as never;
      }
    },
  );

  // --- S5: unlink (FR-28) — revoke at Plaid, discard locally, keep history ---
  // The client is resolved leniently: even with Plaid unconfigured or the
  // token dead, the LOCAL discard must proceed (AC-3); the failed revoke is
  // logged to sync health inside unlinkPlaidItem.
  app.post<{ Params: { id: string } }>(
    '/api/plaid/items/:id/unlink',
    async (req, reply): Promise<PlaidItemResponse> => {
      let client: PlaidClientPort | null = null;
      try {
        const status = getPlaidCredentialsStatus(db);
        const secret = masterKey && status.configured ? getPlaidSecret(db, masterKey) : undefined;
        if (status.configured && status.clientId !== null && secret !== undefined) {
          client = clientFactory({
            clientId: status.clientId,
            secret,
            environment: getPlaidEnvironment(db, env),
          });
        }
      } catch {
        client = null; // revoke becomes a logged failure; the unlink continues
      }
      try {
        return itemResponse(await unlinkPlaidItem(db, masterKey ?? null, client, req.params.id));
      } catch (err) {
        return sendImportError(reply, err) as never;
      }
    },
  );
}
