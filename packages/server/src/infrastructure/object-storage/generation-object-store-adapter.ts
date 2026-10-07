/**
 * P4A-I09 adapter: wraps the I06 throwing `BlobStorePort` into the
 * attachments module's `GenerationObjectStorePort` (closed outcome unions).
 *
 * The module must never import infrastructure/provider types, so this adapter
 * is the ONLY place where `BlobStoreError` / `BlobStoreReadOverflowError` are
 * translated into the module port's outcome classes. Provider HEAD/GET/DELETE
 * stay OUTSIDE any database transaction.
 *
 * P4A-I11: the adapter also accepts the read-only subset of the I06 surface
 * (the credential-free delivery process), forwards the upstream `signal` to
 * HEAD and the restricted single `range` to GET, and exposes `close` so the
 * delivery host can terminate its RO client.
 *
 * P4A-I14: the adapter wires `deleteExact` + `confirmAbsent` for the cleanup
 * RW store. A store WITHOUT a delete path (the RO-only delivery store) fails
 * `deleteExact` closed with `denied` and derives `confirmAbsent` from
 * `headExact` — the credential-free process structurally cannot delete.
 */
import {
  BlobStoreError,
  BlobStoreReadOverflowError,
} from './blob-store-port.js';
import type {
  BlobStorePort,
  HeadExactOutcome,
  ReadBoundedOutcome,
} from './blob-store-port.js';
import type {
  GenerationDeleteOutcome,
  GenerationHeadOutcome,
  GenerationObjectHandle,
  GenerationObjectIdentity,
  GenerationObjectStorePort,
  GenerationReadOptions,
  GenerationReadOutcome,
} from '../../modules/attachments/index.js';

/** The I06 surface the adapter needs: exact HEAD + bounded ranged read. */
export type DeliveryCompatibleObjectStore = Pick<BlobStorePort, 'headExact' | 'readBounded'>;

/**
 * The I06 surface the cleanup RW store provides. The RO-only store satisfies
 * the structural subset via the optional write members.
 */
export type CleanupCompatibleObjectStore = DeliveryCompatibleObjectStore & Partial<Pick<BlobStorePort, 'deleteExact' | 'confirmAbsent'>>;

export function createGenerationObjectStoreAdapter(store: CleanupCompatibleObjectStore): GenerationObjectStorePort {
  return Object.freeze({
    async headExact(
      handle: GenerationObjectHandle,
      options: { expectedEtag?: string; signal?: AbortSignal } = {},
    ): Promise<GenerationHeadOutcome> {
      try {
        const outcome: HeadExactOutcome = await store.headExact(handle, {
          expectedEtag: options.expectedEtag,
          signal: options.signal,
        });
        if (!outcome.found) return { class: 'not_found' };
        return { class: 'ok', identity: toModuleIdentity(outcome.identity) };
      } catch (error) {
        return classifyHeadError(error);
      }
    },
    async readBounded(handle: GenerationObjectHandle, options: GenerationReadOptions): Promise<GenerationReadOutcome> {
      try {
        const outcome: ReadBoundedOutcome = await store.readBounded(handle, {
          expectedEtag: options.expectedEtag,
          byteCeiling: options.byteCeiling,
          signal: options.signal,
          range: options.range,
        });
        if (!outcome.found) return { class: 'not_found' };
        return {
          class: 'ok',
          identity: toModuleIdentity(outcome.identity),
          stream: outcome.stream,
        };
      } catch (error) {
        if (error instanceof BlobStoreReadOverflowError) {
          return { class: 'overflow', byteCeiling: error.byteCeiling };
        }
        return classifyReadError(error);
      }
    },
    async deleteExact(handle: GenerationObjectHandle, options?: { readonly signal?: AbortSignal }): Promise<GenerationDeleteOutcome> {
      if (typeof store.deleteExact !== 'function') {
        // The RO-only delivery store has no write path; fail closed.
        return { class: 'denied' };
      }
      try {
        const outcome = await store.deleteExact(handle, options);
        if (outcome.outcome === 'deleted') return { class: 'deleted' };
        if (outcome.outcome === 'absent') return { class: 'not_found' };
        return { class: 'unknown' };
      } catch (error) {
        return classifyDeleteError(error);
      }
    },
    async confirmAbsent(handle: GenerationObjectHandle): Promise<{ readonly absent: boolean }> {
      if (typeof store.confirmAbsent === 'function') {
        try {
          return await store.confirmAbsent(handle);
        } catch (error) {
          // Any provider failure means "not confirmed absent" — the only safe
          // closed representation. The coordinator never decides on this alone.
          return { absent: false };
        }
      }
      // RO fallback: absence is derived from an exact-key HEAD.
      const head = await this.headExact(handle);
      return { absent: head.class === 'not_found' };
    },
    async close(): Promise<void> {
      const candidate = store as { close?: () => Promise<void> };
      if (typeof candidate.close === 'function') {
        await candidate.close();
      }
    },
  });
}

function toModuleIdentity(identity: {
  generationId: string;
  size: number;
  etag: string;
  metadata: Readonly<Record<string, string>>;
  contentType?: string | null;
  lastModifiedIso?: string;
}): GenerationObjectIdentity {
  return {
    generationId: identity.generationId,
    size: identity.size,
    etag: identity.etag,
    metadata: identity.metadata,
    contentType: identity.contentType ?? null,
    lastModifiedIso: identity.lastModifiedIso,
  };
}

function classifyHeadError(error: unknown): GenerationHeadOutcome {
  if (error instanceof BlobStoreError) {
    if (error.class === 'precondition' || error.code === 'etag_mismatch') return { class: 'etag_mismatch' };
    if (error.class === 'not_found') return { class: 'not_found' };
    if (error.class === 'denied') return { class: 'denied' };
    if (error.class === 'retryable') return { class: 'retryable' };
    return { class: 'unknown' };
  }
  return { class: 'unknown' };
}

function classifyReadError(error: unknown): GenerationReadOutcome {
  if (error instanceof BlobStoreError) {
    if (error.class === 'precondition' || error.code === 'etag_mismatch') return { class: 'etag_mismatch' };
    if (error.class === 'not_found') return { class: 'not_found' };
    if (error.class === 'denied') return { class: 'denied' };
    if (error.class === 'retryable' || error.class === 'aborted') return { class: 'retryable' };
    return { class: 'unknown' };
  }
  return { class: 'unknown' };
}

function classifyDeleteError(error: unknown): GenerationDeleteOutcome {
  if (error instanceof BlobStoreError) {
    if (error.class === 'not_found') return { class: 'not_found' };
    if (error.class === 'denied') return { class: 'denied' };
    if (error.class === 'retryable') return { class: 'retryable' };
    return { class: 'unknown' };
  }
  return { class: 'unknown' };
}
