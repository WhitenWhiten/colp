/**
 * P4A-R06 PostgreSQL implementation of the shared exposure FACTS port.
 *
 * Resolves ONLY logical blob facts (`blobId` / `logicalState` /
 * `currentGenerationState`) for a collection scope. The physical generation
 * key, bucket, fingerprint, body and provider metadata are deliberately NOT
 * selected: a consumer that depends on this port can never obtain the
 * physical identity of a private blob — the exposure-eligibility gate is the
 * only policy it may apply.
 *
 * Blobs are collection-scoped through `upload_intents` (the allocation
 * authority); the current generation is joined through `blob_records`.
 */
import { sql } from 'kysely';
import type { DatabaseRuntime } from './runtime.js';
import type {
  SharedExposureBlobFacts,
  SharedExposureFactsPort,
  SharedExposureFactsScope,
} from '../../modules/exposure/index.js';
import { assertSharedExposureFactsScope } from '../../modules/exposure/index.js';

export function createPostgresSharedExposureFactsPort(
  runtime: DatabaseRuntime,
): SharedExposureFactsPort {
  return Object.freeze({
    async listBlobFacts(scope: SharedExposureFactsScope,
      options?: { readonly signal?: AbortSignal }): Promise<readonly SharedExposureBlobFacts[]> {
      options?.signal?.throwIfAborted();
      assertSharedExposureFactsScope(scope);
      if (scope.blobIds.length === 0) return Object.freeze([]);
      const collectionIds = scope.collectionIds ?? [scope.collectionId];
      const rows = await sql<{
        blob_id: string;
        logical_state: string;
        generation_state: string | null;
      }>`
        select b.blob_id, b.logical_state, g.generation_state
          from blob_records b
          left join blob_generations g on g.generation_id = b.current_generation_id
         where b.blob_id = any(${scope.blobIds}::text[])
           and exists (select 1 from upload_intents u
             where u.blob_id = b.blob_id and u.collection_id = any(${collectionIds}::text[]))
         order by b.blob_id
      `.execute(runtime.db, options?.signal
        ? { signal: options.signal, inflightQueryAbortStrategy: 'cancel query' }
        : undefined);
      options?.signal?.throwIfAborted();
      return Object.freeze(rows.rows.map((row) => Object.freeze({
        blobId: row.blob_id,
        logicalState: row.logical_state as SharedExposureBlobFacts['logicalState'],
        currentGenerationState: row.generation_state as SharedExposureBlobFacts['currentGenerationState'],
      })));
    },
  });
}
