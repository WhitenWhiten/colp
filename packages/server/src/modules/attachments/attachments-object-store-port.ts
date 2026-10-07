/**
 * P4A-I09 narrow object-store port for generation attestation and
 * verification (extended by P4A-I11 for delivery reads and P4A-I14 for the
 * cleanup write path).
 *
 * The attachments module must never import infrastructure types (import
 * boundaries), so this port returns closed outcome unions instead of throwing
 * provider error classes. The production I06 `BlobStorePort` satisfies the
 * port structurally;
 * `src/infrastructure/object-storage/generation-object-store-adapter.ts`
 * adapts the throwing I06 surface into these outcome unions. Provider
 * HEAD/GET/DELETE happen OUTSIDE any database transaction (plan §6 I09/I14).
 *
 * P4A-I11 additions: an optional `signal` on `headExact` (upstream timeout),
 * an optional restricted single `range` on `readBounded` (the delivery
 * policy only ever asks for a validated single byte window), and an optional
 * `close` so the credential-free delivery process can terminate its RO
 * client.
 *
 * P4A-I14 additions: `deleteExact` (exact-key DELETE, never a provider
 * precondition) and `confirmAbsent` (absence via exact-key HEAD — a DELETE
 * 2xx alone is never absence). Cleanup uses the RW store through the same
 * adapter; the RO-only delivery store fails `deleteExact` closed with
 * `denied` and derives `confirmAbsent` from `headExact`.
 */
export interface GenerationObjectHandle {
  readonly generationId: string;
  readonly key: string;
}

export interface GenerationObjectIdentity {
  readonly generationId: string;
  readonly size: number;
  readonly etag: string;
  /** Canonicalized provider metadata (lowercased keys, no prefix). */
  readonly metadata: Readonly<Record<string, string>>;
  readonly contentType?: string | null;
  readonly lastModifiedIso?: string;
}

export type GenerationHeadOutcome =
  | { readonly class: 'ok'; readonly identity: GenerationObjectIdentity }
  | { readonly class: 'not_found' }
  | { readonly class: 'etag_mismatch' }
  | { readonly class: 'denied' }
  | { readonly class: 'retryable' }
  | { readonly class: 'unknown' };

export type GenerationReadOutcome =
  | {
      readonly class: 'ok';
      readonly identity: GenerationObjectIdentity;
      readonly stream: AsyncIterable<Uint8Array>;
    }
  | { readonly class: 'not_found' }
  | { readonly class: 'etag_mismatch' }
  | { readonly class: 'denied' }
  | { readonly class: 'retryable' }
  | { readonly class: 'unknown' }
  | { readonly class: 'overflow'; readonly byteCeiling: number };

export interface GenerationReadOptions {
  /** Conditional read validator; mismatch before read -> etag_mismatch. */
  readonly expectedEtag: string;
  /** Hard byte ceiling; a provider object larger than this is `overflow`. */
  readonly byteCeiling: number;
  readonly signal: AbortSignal;
  /**
   * P4A-I11: restricted single-range read. Only ever set by the delivery
   * policy after validating a single `bytes=` range against the HEAD size;
   * the provider is asked for exactly this inclusive byte window and the
   * ceiling applies to its length.
   */
  readonly range?: { readonly start: number; readonly end: number };
}

/**
 * P4A-I14 exact-key DELETE outcome. `deleted` means the provider returned a
 * 2xx to the unconditional exact-key DELETE; it is NEVER absence on its own —
 * the coordinator repeats an exact-key HEAD (`headExact`) and only then CASes
 * `deleted` evidence. `not_found` means the provider reported the key absent
 * (DELETE 404), which the coordinator still reconciles with a HEAD.
 */
export type GenerationDeleteOutcome =
  | { readonly class: 'deleted' }
  | { readonly class: 'not_found' }
  | { readonly class: 'denied' }
  | { readonly class: 'retryable' }
  | { readonly class: 'unknown' };

export interface GenerationObjectStorePort {
  headExact(
    handle: GenerationObjectHandle,
    options?: { readonly expectedEtag?: string; readonly signal?: AbortSignal },
  ): Promise<GenerationHeadOutcome>;
  readBounded(handle: GenerationObjectHandle, options: GenerationReadOptions): Promise<GenerationReadOutcome>;
  /** P4A-I14 exact-key DELETE (no If-Match); the coordinator always HEAD-confirms. */
  deleteExact(handle: GenerationObjectHandle, options?: { readonly signal?: AbortSignal }): Promise<GenerationDeleteOutcome>;
  /**
   * P4A-I14 absence confirmation via exact-key HEAD. `absent: false` means
   * "not confirmed absent" (still present, denied, retryable, or unknown) —
   * the ONLY safe closed representation of an inconclusive confirm.
   */
  confirmAbsent(handle: GenerationObjectHandle): Promise<{ readonly absent: boolean }>;
  /** P4A-I11: terminates the underlying RO client; idempotent. */
  close?(): Promise<void>;
}
