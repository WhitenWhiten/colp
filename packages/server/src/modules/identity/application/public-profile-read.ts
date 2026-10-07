export interface PublicProfileFacts {
  /** Identity-owned stable Profile identity used by Follow. */
  readonly profileId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  /** Public self-introduction. Empty string when unset. */
  readonly about: string;
  /** Internal composition fact. Never include this identity in the public DTO. */
  readonly ownerSubjectId: string;
}

export interface PublicProfileFactsReadPort {
  findByCanonicalHandle(canonicalHandle: string): Promise<PublicProfileFacts | null>;
}

export interface PublicProfileOwnerFactsReadPort {
  findByOwnerSubjectId(ownerSubjectId: string): Promise<PublicProfileFacts | null>;
  /** Batch owner-subject lookup keyed by subject id, for directory projections that must not go N+1. */
  findManyByOwnerSubjectIds?(
    ownerSubjectIds: readonly string[],
  ): Promise<ReadonlyMap<string, PublicProfileFacts>>;
}

export async function getPublicProfileFacts(
  reads: PublicProfileFactsReadPort,
  canonicalHandle: string,
): Promise<PublicProfileFacts | null> {
  if (!isCanonicalPublicProfileHandle(canonicalHandle)) {
    throw new TypeError('Public Profile facts query requires a canonical handle');
  }
  return reads.findByCanonicalHandle(canonicalHandle);
}

export function isCanonicalPublicProfileHandle(value: string): boolean {
  return value !== '.'
    && value !== '..'
    && /^[a-z0-9._~-]{1,64}$/u.test(value);
}
