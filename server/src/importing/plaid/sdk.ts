import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import type { CountryCode, Products, RemovedTransaction, Transaction } from 'plaid';
import {
  PlaidApiError,
  type PlaidClientPort,
  type PlaidSyncPage,
  type PlaidTransactionData,
} from './client.js';

/**
 * The ONE real PlaidClientPort implementation, wrapping the official `plaid`
 * SDK (ADR-002). Never constructed by the test suite — tests inject a fake at
 * the PlaidClientPort seam; this adapter is exercised manually against the
 * Plaid sandbox (`npm run sync:sandbox -w @ynab-clone/server`, see README).
 *
 * Credentials arrive pre-resolved from the web layer (admin/plaid.ts owns
 * them; importing may not import admin per ADR-001).
 */

export type PlaidEnvironmentName = 'sandbox' | 'production';

export interface PlaidCredentials {
  clientId: string;
  secret: string;
  environment: PlaidEnvironmentName;
}

export type PlaidClientFactory = (credentials: PlaidCredentials) => PlaidClientPort;

/**
 * The SDK parses Plaid's JSON, so `amount` reaches us as a JS number. Convert
 * to the decimal string the port requires via the shortest-round-trip string
 * representation — exact for every real-world 2-decimal currency amount —
 * so all milliunit MATH stays on the audited string parser (ADR-004).
 */
function amountToDecimalString(amount: number): string {
  return String(amount);
}

/** Surface Plaid's error_code (ITEM_LOGIN_REQUIRED, sync-mutation, …) for the sync log. */
function toPlaidApiError(err: unknown): unknown {
  const data = (err as { response?: { data?: { error_code?: string; error_message?: string } } })
    .response?.data;
  if (data?.error_code !== undefined) {
    return new PlaidApiError(data.error_code, data.error_message ?? data.error_code);
  }
  return err;
}

function toTransactionData(txn: Transaction): PlaidTransactionData {
  return {
    transactionId: txn.transaction_id,
    plaidAccountId: txn.account_id,
    date: txn.date,
    name: txn.merchant_name ?? txn.name,
    amount: amountToDecimalString(txn.amount),
    pending: txn.pending,
    raw: txn,
  };
}

export const createPlaidSdkClient: PlaidClientFactory = (credentials) => {
  // PlaidEnvironments is an index signature (string | undefined); both names in
  // PlaidEnvironmentName are guaranteed members.
  const basePath = PlaidEnvironments[credentials.environment];
  if (basePath === undefined) throw new Error(`unknown Plaid environment ${credentials.environment}`);
  const api = new PlaidApi(
    new Configuration({
      basePath,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': credentials.clientId,
          'PLAID-SECRET': credentials.secret,
        },
      },
    }),
  );

  return {
    async createLinkToken(): Promise<string> {
      try {
        const res = await api.linkTokenCreate({
          client_name: 'ynab-clone',
          language: 'en',
          country_codes: ['CA' as CountryCode],
          user: { client_user_id: 'ynab-clone-single-user' }, // single-user app (AS-3)
          products: ['transactions' as Products],
        });
        return res.data.link_token;
      } catch (err) {
        throw toPlaidApiError(err);
      }
    },

    async createUpdateLinkToken(accessToken: string): Promise<string> {
      try {
        // Link UPDATE MODE (E5.S4, FR-26): the access token identifies the
        // Item to re-authenticate; `products` is omitted per Plaid's
        // update-mode docs — same Item, cursor and mappings preserved.
        const res = await api.linkTokenCreate({
          client_name: 'ynab-clone',
          language: 'en',
          country_codes: ['CA' as CountryCode],
          user: { client_user_id: 'ynab-clone-single-user' },
          access_token: accessToken,
        });
        return res.data.link_token;
      } catch (err) {
        throw toPlaidApiError(err);
      }
    },

    async exchangePublicToken(publicToken: string) {
      try {
        const res = await api.itemPublicTokenExchange({ public_token: publicToken });
        return { accessToken: res.data.access_token, plaidItemId: res.data.item_id };
      } catch (err) {
        throw toPlaidApiError(err);
      }
    },

    async getItemAccounts(accessToken: string) {
      try {
        const res = await api.accountsGet({ access_token: accessToken });
        // institution_name rides on the item in current API versions.
        const item = res.data.item as { institution_name?: string | null };
        return {
          institutionName: item.institution_name ?? null,
          accounts: res.data.accounts.map((a) => ({
            plaidAccountId: a.account_id,
            name: a.name,
            mask: a.mask ?? null,
            type: String(a.type),
            subtype: a.subtype === null || a.subtype === undefined ? null : String(a.subtype),
          })),
        };
      } catch (err) {
        throw toPlaidApiError(err);
      }
    },

    async transactionsSync(accessToken: string, cursor: string | null): Promise<PlaidSyncPage> {
      try {
        const res = await api.transactionsSync({
          access_token: accessToken,
          ...(cursor === null ? {} : { cursor }),
        });
        return {
          added: res.data.added.map(toTransactionData),
          modified: res.data.modified.map(toTransactionData),
          removed: res.data.removed.map((r: RemovedTransaction) => ({
            transactionId: r.transaction_id,
            plaidAccountId: (r as { account_id?: string | null }).account_id ?? null,
          })),
          nextCursor: res.data.next_cursor,
          hasMore: res.data.has_more,
        };
      } catch (err) {
        throw toPlaidApiError(err);
      }
    },

    async removeItem(accessToken: string): Promise<void> {
      try {
        // E5.S5 (FR-28): revoke the access token at Plaid; also frees the
        // Item's slot under the Trial plan's 10-Item cap.
        await api.itemRemove({ access_token: accessToken });
      } catch (err) {
        throw toPlaidApiError(err);
      }
    },
  };
};
