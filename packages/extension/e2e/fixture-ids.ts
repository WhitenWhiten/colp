/**
 * Canonical 16-byte base64url collection id for the P3-27 e2e fixture.
 *
 * Social collection-change outbox (appended on every canonical mutation)
 * rejects non-opaque ids with CanonicalMutationInvariantError, which COLP
 * maps to `invalid_document`. `owned-default` is not a valid opaque id.
 */
export const FIXTURE_COLLECTION_ID = 'P327OwnedDefaultAAAAAA';
