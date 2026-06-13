/**
 * Hand-rolled Plaid Link loader (E5.S1 AC-4, NFR-2, ADR-008).
 *
 * NFR-2 forbids third-party origins at runtime, with ONE documented carve-out:
 * the Plaid Link widget during link/re-link. This module is the entire scope
 * of that exception — it is imported only by the (lazy-loaded) connections
 * screen, and the CDN script tag is injected only when the user actually
 * starts a link flow. No other page references any third-party origin, and
 * a `react-plaid-link` dependency (which loads the same CDN script anyway)
 * stays out of the bundle.
 */

export const PLAID_LINK_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

export interface PlaidLinkHandler {
  open(): void;
  exit(): void;
}

export interface PlaidLinkCreateOptions {
  token: string;
  onSuccess(publicToken: string): void;
  /** error is null when the user simply closed the widget. */
  onExit(error: { error_message?: string } | null): void;
}

/** The `window.Plaid` global the CDN script installs. */
export interface PlaidLinkGlobal {
  create(options: PlaidLinkCreateOptions): PlaidLinkHandler;
}

/** Injectable seam: tests provide a fake; production injects the CDN script. */
export type PlaidLinkLoader = () => Promise<PlaidLinkGlobal>;

declare global {
  interface Window {
    Plaid?: PlaidLinkGlobal;
  }
}

let pending: Promise<PlaidLinkGlobal> | null = null;

export const loadPlaidLink: PlaidLinkLoader = () => {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  pending ??= new Promise<PlaidLinkGlobal>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PLAID_LINK_SRC;
    script.async = true;
    script.onload = () => {
      if (window.Plaid) resolve(window.Plaid);
      else reject(new Error('Plaid Link script loaded but window.Plaid is missing'));
    };
    script.onerror = () => {
      pending = null; // allow a retry after a transient network failure
      script.remove();
      reject(new Error('Could not load the Plaid Link script.'));
    };
    document.head.appendChild(script);
  });
  return pending;
};
