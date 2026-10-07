/**
 * Deny-by-default shared exposure. No content-safety capability exists, so
 * Sync and MCP snapshots carry `attachments: []`. The eligibility union has
 * exactly one member (ineligible). A future eligible verdict must be an
 * intentional capability change, not a missing field.
 */

export const SHARED_EXPOSURE_INELIGIBILITY_REASON = 'no_content_safety_evidence' as const;
export const OWNER_PRIVATE_EXPOSURE_MODE = 'owner-private-unscanned' as const;

export interface SharedExposureBlobFacts {
  readonly blobId: string;
  readonly logicalState: string;
  readonly currentGenerationState: string | null;
}

export interface IneligibleSharedExposure {
  readonly eligible: false;
  readonly reason: typeof SHARED_EXPOSURE_INELIGIBILITY_REASON;
  readonly exposureMode: typeof OWNER_PRIVATE_EXPOSURE_MODE;
  readonly blobId: string;
  readonly logicalState: string;
  readonly currentGenerationState: string | null;
}

/** Closed exposure union: ineligible is the only member. */
export type SharedExposureEligibility = IneligibleSharedExposure;

/** Name used by MCP collection resources in place of the attachments module. */
export type DenyByDefaultExposure = SharedExposureEligibility;

export interface SharedExposureFactsScope {
  readonly collectionId: string;
  readonly collectionIds?: readonly string[];
  readonly blobIds: readonly string[];
}

export interface SharedExposureFactsPort {
  listBlobFacts(
    scope: SharedExposureFactsScope,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly SharedExposureBlobFacts[]>;
}

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

export function assessSharedExposureEligibility(facts: SharedExposureBlobFacts): DenyByDefaultExposure {
  if (typeof facts?.blobId !== 'string' || facts.blobId.length === 0) {
    throw new TypeError('SharedExposureBlobFacts.blobId must be a non-empty string');
  }
  return Object.freeze({
    eligible: false,
    reason: SHARED_EXPOSURE_INELIGIBILITY_REASON,
    exposureMode: OWNER_PRIVATE_EXPOSURE_MODE,
    blobId: facts.blobId,
    logicalState: facts.logicalState,
    currentGenerationState: facts.currentGenerationState,
  });
}

export function assertSharedExposureIneligible(
  verdict: SharedExposureEligibility,
): asserts verdict is DenyByDefaultExposure {
  if (verdict.eligible !== false) {
    throw new Error('Shared exposure eligibility must be deny-by-default until content-safety evidence exists');
  }
}

/**
 * Resolves only the output candidates. An empty candidate list performs no
 * facts I/O and yields no attachment projection.
 */
export async function assessSharedExposureScope(
  factsPort: SharedExposureFactsPort,
  scope: SharedExposureFactsScope,
  options?: { readonly signal?: AbortSignal },
): Promise<readonly DenyByDefaultExposure[]> {
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

export function assertSharedExposureScopeIneligible(
  verdicts: readonly SharedExposureEligibility[],
): void {
  for (const verdict of verdicts) assertSharedExposureIneligible(verdict);
}
