import type {
  PublisherIdempotencyBinding,
  PublisherIdempotencyClaim,
  PublisherIdempotencyPort,
  PublisherStoredResult,
} from './ports.js';

interface MemoryPublisherReceipt {
  readonly fingerprint: string;
  status: 'in_progress' | 'completed';
  result?: PublisherStoredResult;
}

function bindingKey(binding: PublisherIdempotencyBinding): string {
  return `${binding.namespace}\0${binding.principalId}\0${binding.idempotencyKey}`;
}

function assertBinding(binding: PublisherIdempotencyBinding): void {
  if (!binding.namespace?.trim()) throw new Error('publisher namespace is required');
  if (!binding.principalId?.trim()) throw new Error('publisher principalId is required');
  if (!binding.idempotencyKey?.trim()) throw new Error('publisher idempotencyKey is required');
}

/**
 * In-memory Publisher idempotency for internal contract harness / unit tests.
 * Does not share storage with Product command receipts.
 */
export function createMemoryPublisherIdempotencyPort(
  store: Map<string, MemoryPublisherReceipt> = new Map(),
): PublisherIdempotencyPort & { readonly store: Map<string, MemoryPublisherReceipt> } {
  const port: PublisherIdempotencyPort & { readonly store: Map<string, MemoryPublisherReceipt> } = {
    store,
    async claim(binding, fingerprint): Promise<PublisherIdempotencyClaim> {
      assertBinding(binding);
      if (!fingerprint?.trim()) throw new Error('publisher fingerprint is required');
      const key = bindingKey(binding);
      const existing = store.get(key);
      if (!existing) {
        store.set(key, { fingerprint, status: 'in_progress' });
        return { kind: 'claimed' };
      }
      if (existing.fingerprint !== fingerprint) {
        return { kind: 'reused' };
      }
      if (existing.status === 'in_progress') {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      if (!existing.result) {
        throw new Error('completed publisher receipt is missing result');
      }
      return {
        kind: 'replay',
        result: {
          status: existing.result.status,
          body: existing.result.body.slice(),
          stableHeaders: { ...existing.result.stableHeaders },
          mediaType: existing.result.mediaType,
          contractVersion: existing.result.contractVersion,
          targetIdentity: existing.result.targetIdentity,
        },
      };
    },

    async complete(binding, fingerprint, result): Promise<void> {
      assertBinding(binding);
      const key = bindingKey(binding);
      const existing = store.get(key);
      if (!existing || existing.fingerprint !== fingerprint) {
        throw new Error('publisher receipt was not claim owner');
      }
      if (existing.status === 'completed') {
        throw new Error('publisher receipt already completed');
      }
      existing.status = 'completed';
      existing.result = {
        status: result.status,
        body: result.body.slice(),
        stableHeaders: { ...result.stableHeaders },
        mediaType: result.mediaType,
        contractVersion: result.contractVersion,
        targetIdentity: result.targetIdentity,
      };
    },
  };
  return port;
}

export type { MemoryPublisherReceipt };
