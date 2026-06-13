import type { PlaidItemResponse } from '@tyche/shared';

/**
 * App-wide broken-connection banner (E5.S4 AC-1/AC-5, FR-26): rendered by the
 * SHELL on every view — not just the connections screen — whenever any Item
 * sits in NEEDS_RELINK. Shows the connection and its last-successful-sync
 * time, links straight to the re-link action, and points at the file-import
 * fallback (E4.S1) in the meantime. Deliberately free of any Plaid Link
 * imports so the main bundle keeps zero third-party references (NFR-2,
 * ADR-008 — the Link loader lives only in the lazy connections chunk).
 */

export interface SyncBannerProps {
  items: PlaidItemResponse[];
  /** Jump to the connections screen and start update mode for this Item. */
  onRelink(itemId: string): void;
}

export function SyncBanner({ items, onRelink }: SyncBannerProps): React.JSX.Element | null {
  const broken = items.filter((item) => item.status === 'NEEDS_RELINK');
  if (broken.length === 0) return null;
  return (
    <div className="sync-banner" role="alert">
      {broken.map((item) => (
        <p key={item.id}>
          <strong>{item.institutionName ?? 'A bank connection'} needs to be re-linked.</strong>{' '}
          Automatic sync is paused —{' '}
          {item.lastSuccessAt
            ? `last successful sync ${item.lastSuccessAt}`
            : 'it has never synced successfully'}
          . You can import an OFX/CSV file while it is broken.{' '}
          <button type="button" onClick={() => onRelink(item.id)}>
            Re-link now
          </button>
        </p>
      ))}
    </div>
  );
}
