import { createHash } from 'node:crypto';

/**
 * Stable Feed item identity for R5-05 fan-out writes.
 *
 * These bytes are a persistent idempotency contract: the derived id is stored in
 * social_feed_items and re-derived on every retry (on conflict do nothing). Changing the hash
 * separator or prefix would orphan previously committed rows, so any new derivation must be
 * introduced as a versioned scheme, never by editing these bytes in place.
 */
export function stableFeedItemId(eventId: string, recipientProfileId: string): string {
  return createHash('sha256').update(`${eventId}\0${recipientProfileId}`).digest('base64url');
}

/**
 * Stable Notification intent identity: distinct namespaces for the domain event and its
 * outbox row so the two resources can never collide in resource_id_ledger. Same persistent
 * idempotency contract as {@link stableFeedItemId}.
 */
export function stableIntentId(kind: 'event' | 'outbox', feedItemId: string): string {
  return createHash('sha256').update(`social.feed-item-published\0${kind}\0${feedItemId}`, 'utf8')
    .digest('base64url');
}

/**
 * Continuation cursor for a fan-out candidate page.
 *
 * The cursor is the last candidate of the page, never an INSERT RETURNING success row:
 * conflicts (on conflict do nothing) must not stall the cursor, so retries resume past
 * conflicted candidates. Returns null only when the page has no candidates, in which case
 * the caller must not continue.
 */
export function fanoutPageContinuationCursor(page: readonly string[]): string | null {
  return page.length === 0 ? null : page[page.length - 1]!;
}
