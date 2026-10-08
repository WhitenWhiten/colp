/**
 * Publisher durable idempotency ports (ADR-0003).
 *
 * Isolated from Product command receipts: distinct table, PK dimensions, and
 * admission ownership. Canonical Mutation / collections write ports are shared;
 * only the claim/receipt owner differs.
 */

export const PUBLISHER_IDEMPOTENCY_TABLE = 'publisher_idempotency' as const;
export const PRODUCT_COMMAND_RECEIPT_TABLE = 'product_command_receipts' as const;

/** Stable Publisher binding — fingerprint is NOT part of the unique winner key. */
export interface PublisherIdempotencyBinding {
  readonly namespace: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
}

/** Exact replay envelope owned by Publisher admission (not Canonical Mutation). */
export interface PublisherStoredResult {
  readonly status: number;
  readonly body: Uint8Array;
  readonly stableHeaders: Readonly<Record<string, string>>;
  readonly mediaType: string;
  readonly contractVersion: string;
  readonly targetIdentity?: string;
}

export type PublisherIdempotencyClaim =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'replay'; readonly result: PublisherStoredResult }
  | { readonly kind: 'reused' };

/**
 * Transaction-bound Publisher idempotency owner.
 * Implementations MUST enforce UNIQUE (namespace, principal_id, idempotency_key)
 * and compare fingerprint only after a binding exists.
 */
export interface PublisherIdempotencyPort {
  claim(
    binding: PublisherIdempotencyBinding,
    fingerprint: string,
  ): Promise<PublisherIdempotencyClaim>;

  complete(
    binding: PublisherIdempotencyBinding,
    fingerprint: string,
    result: PublisherStoredResult,
  ): Promise<void>;
}

/** Protocol minimum advertised by the Phase 1 Publisher Manifest (24 hours). */
export const PUBLISHER_MIN_REPLAY_WINDOW_SECONDS = 86_400 as const;

/** Background-only receipt cleanup. It is deliberately separate from request admission. */
export interface PublisherReceiptMaintenancePort {
  purgeExpired(options?: { readonly limit?: number }): Promise<number>;
}

export type PublisherReceiptMaintenancePortFactory =
  () => PublisherReceiptMaintenancePort | Promise<PublisherReceiptMaintenancePort>;

export type PublisherIdempotencyPortFactory =
  () => PublisherIdempotencyPort | Promise<PublisherIdempotencyPort>;
