import {
  stableReplayHeaders,
  type ProductCommandBinding,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import type {
  PublisherIdempotencyBinding,
  PublisherIdempotencyClaim,
  PublisherIdempotencyPort,
  PublisherStoredResult,
} from './ports.js';

export interface AdmitPublisherMutationInput<TResult extends PublisherStoredResult> {
  readonly binding: PublisherIdempotencyBinding;
  readonly fingerprint: string;
  /** Runs only after a successful claim; must not open nested transactions. */
  readonly execute: () => Promise<TResult>;
}

export type AdmitPublisherMutationResult<TResult extends PublisherStoredResult> =
  | { readonly kind: 'executed'; readonly result: TResult }
  | { readonly kind: 'replay'; readonly result: PublisherStoredResult }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' };

/**
 * Publisher admission: claim namespace binding, run mutation, complete exact result.
 * Caller supplies ports already bound to a single transaction (UoW owned by admission).
 * Does not nest transactions or touch product_command_receipts.
 */
export async function admitPublisherMutation<TResult extends PublisherStoredResult>(
  idempotency: PublisherIdempotencyPort,
  input: AdmitPublisherMutationInput<TResult>,
): Promise<AdmitPublisherMutationResult<TResult>> {
  const claim = await idempotency.claim(input.binding, input.fingerprint);
  if (claim.kind !== 'claimed') {
    return mapNonClaimed(claim);
  }

  const result = await input.execute();
  await idempotency.complete(input.binding, input.fingerprint, result);
  return { kind: 'executed', result };
}

function mapNonClaimed(
  claim: Exclude<PublisherIdempotencyClaim, { kind: 'claimed' }>,
): Exclude<AdmitPublisherMutationResult<PublisherStoredResult>, { kind: 'executed' }> {
  switch (claim.kind) {
    case 'replay':
      return { kind: 'replay', result: claim.result };
    case 'in_progress':
      return { kind: 'in_progress', retryAfterSeconds: claim.retryAfterSeconds };
    case 'reused':
      return { kind: 'reused' };
    default: {
      const _exhaustive: never = claim;
      return _exhaustive;
    }
  }
}

export interface PublisherAsProductReceiptOptions {
  /**
   * Publisher namespace owner for this admission surface.
   * Independent of Product command_scope even when strings coincide.
   */
  readonly namespace: string;
}

/**
 * Maps ProductCommandReceiptPort → PublisherIdempotencyPort storage.
 * Enables reusing createOwnedCollectionCanonical (and other receipt-gated collections use cases)
 * under Publisher ownership without sharing product_command_receipts.
 *
 * Mapping:
 * - principalId → principalId
 * - commandId → idempotencyKey
 * - options.namespace → namespace (fixed for this admission surface)
 * - Product command_scope is intentionally not the Publisher winner key
 */
export function adaptPublisherIdempotencyAsProductReceipts(
  publisher: PublisherIdempotencyPort,
  options: PublisherAsProductReceiptOptions,
): ProductCommandReceiptPort {
  if (!options.namespace?.trim()) {
    throw new Error('publisher namespace is required for Product receipt adapter');
  }

  const toPublisherBinding = (binding: ProductCommandBinding): PublisherIdempotencyBinding => ({
    namespace: options.namespace,
    principalId: binding.principalId,
    idempotencyKey: binding.commandId,
  });

  return {
    async claim(binding, fingerprint): Promise<ProductCommandClaim> {
      const claim = await publisher.claim(toPublisherBinding(binding), fingerprint);
      return mapPublisherClaimToProduct(claim);
    },

    async complete(binding, fingerprint, result): Promise<void> {
      await publisher.complete(
        toPublisherBinding(binding),
        fingerprint,
        toPublisherStoredResult(result),
      );
    },

    async purgeExpired(): Promise<number> {
      // Publisher harness retention is not product receipt compaction.
      return 0;
    },

    async deletePrincipalReceipts(): Promise<number> {
      // Account-removal product path does not delete publisher bindings via this adapter.
      return 0;
    },
  };
}

function mapPublisherClaimToProduct(claim: PublisherIdempotencyClaim): ProductCommandClaim {
  switch (claim.kind) {
    case 'claimed':
      return { kind: 'claimed' };
    case 'in_progress':
      return { kind: 'in_progress', retryAfterSeconds: claim.retryAfterSeconds };
    case 'reused':
      return { kind: 'reused' };
    case 'replay':
      return {
        kind: 'replay',
        result: toProductCommandResult(claim.result),
      };
    default: {
      const _exhaustive: never = claim;
      return _exhaustive;
    }
  }
}

function toPublisherStoredResult(result: ProductCommandResult): PublisherStoredResult {
  return {
    status: result.status,
    body: result.body,
    stableHeaders: stableReplayHeaders(result.stableHeaders),
    mediaType: result.mediaType,
    contractVersion: result.contractVersion,
    targetIdentity: result.targetIdentity,
  };
}

function toProductCommandResult(result: PublisherStoredResult): ProductCommandResult {
  return {
    status: result.status,
    body: result.body,
    stableHeaders: result.stableHeaders,
    mediaType: result.mediaType,
    contractVersion: result.contractVersion,
    targetIdentity: result.targetIdentity,
  };
}
