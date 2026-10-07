/**
 * P4A-R06 shared exposure FACTS port: the infrastructure boundary through
 * which a shared consumer resolves ONLY logical blob facts for its projection
 * scope.
 *
 * The facts port is part of the approved eligibility-port shape a consumer
 * may import from the attachments facade (alongside
 * `assessSharedExposureEligibility` / `assertSharedExposureIneligible`):
 *
 * - `SharedExposureBlobFacts` (blobId/logicalState/currentGenerationState)
 *   is the ONLY fact shape — the physical generation key and body are
 *   deliberately absent, so a consumer that depends on this port can never
 *   read or propagate them;
 * - `assessSharedExposureScope` resolves the scope through the port and runs
 *   the deny-by-default gate over every fact; the verdict list shapes the
 *   consumer output (while no content-safety capability exists every verdict
 *   is explicitly ineligible);
 * - `assertSharedExposureScopeIneligible` is the fail-closed consumption
 *   pattern: a future eligible verdict is a reviewed attachments-module
 *   change and must fail loudly instead of silently exposing bytes.
 *
 * The PostgreSQL implementation lives in
 * `src/infrastructure/database/postgres-shared-exposure-facts.ts`.
 */
import {
  assessSharedExposureEligibility,
  assertSharedExposureIneligible,
  type SharedExposureBlobFacts,
  type SharedExposureEligibility,
} from './exposure-eligibility.js';

/**
 * The projection scope a shared consumer may resolve. Blobs are
 * collection-scoped in the ledger.
 *
 * Only blobs actually considered for the current output are candidates.
 * Collection membership restricts those candidates; it never expands the
 * read to a collection's entire attachment history. Outputs with no attachment
 * candidates use an empty list and require no facts query.
 */
export interface SharedExposureFactsScope {
  readonly collectionId: string;
  readonly collectionIds?: readonly string[];
  readonly blobIds: readonly string[];
}

/** Infrastructure-provided resolution of logical blob facts (never keys/bodies). */
export interface SharedExposureFactsPort {
  listBlobFacts(scope: SharedExposureFactsScope,
    options?: { readonly signal?: AbortSignal }): Promise<readonly SharedExposureBlobFacts[]>;
}

/** Fail-fast scope guard; misuse is loud instead of silently denied. */
export function assertSharedExposureFactsScope(value: unknown): asserts value is SharedExposureFactsScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('SharedExposureFactsScope must be an object');
  }
  const scope = value as Partial<SharedExposureFactsScope>;
  if (typeof scope.collectionId !== 'string' || scope.collectionId.length === 0) {
    throw new TypeError('SharedExposureFactsScope.collectionId must be a non-empty string');
  }
  for (const ids of [scope.blobIds, scope.collectionIds ?? [scope.collectionId]]) {
    if (!Array.isArray(ids) || ids.length > 1_000
      || ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 512)) {
      throw new TypeError('Shared exposure candidates and collections must be bounded identity lists');
    }
  }
}

/**
 * Resolves only the output candidates through the facts port and assesses each with the
 * deny-by-default gate. The returned verdicts shape the consumer's projection:
 * while no content-safety capability exists, each verdict is explicitly
 * ineligible, so a consumer that handles the ineligible case projects nothing.
 */
export async function assessSharedExposureScope(
  factsPort: SharedExposureFactsPort,
  scope: SharedExposureFactsScope,
  options?: { readonly signal?: AbortSignal },
): Promise<readonly SharedExposureEligibility[]> {
  options?.signal?.throwIfAborted();
  assertSharedExposureFactsScope(scope);
  if (typeof factsPort?.listBlobFacts !== 'function') {
    throw new TypeError('SharedExposureFactsPort must provide listBlobFacts');
  }
  if (scope.blobIds.length === 0) return Object.freeze([]);
  const facts = await factsPort.listBlobFacts(scope, options);
  options?.signal?.throwIfAborted();
  const requested = new Set(scope.blobIds);
  const seen = new Set<string>();
  if (facts.length > requested.size || facts.some((fact) => {
    if (!requested.has(fact.blobId) || seen.has(fact.blobId)) return true;
    seen.add(fact.blobId);
    return false;
  })) throw new Error('Shared exposure facts must match the bounded output candidates');
  return Object.freeze(facts.map((factsEntry) => assessSharedExposureEligibility(factsEntry)));
}

/**
 * Fail-closed consumption of a scope assessment: every verdict must be the
 * explicit ineligible member. A future eligible verdict (a reviewed
 * attachments-module change backed by content-safety evidence) fails loudly
 * here instead of silently reaching a shared projection.
 */
export function assertSharedExposureScopeIneligible(
  verdicts: readonly SharedExposureEligibility[],
): void {
  for (const verdict of verdicts) {
    assertSharedExposureIneligible(verdict);
  }
}
