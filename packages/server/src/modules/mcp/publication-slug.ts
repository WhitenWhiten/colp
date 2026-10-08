import { createHash } from 'node:crypto';

/**
 * Deterministic publication slug for first public/unlisted MCP visibility.
 * Collection opaque ids are mixed-case base64url and fail the product slug
 * regex; this hash is lowercase `[a-z0-9]` of length 32.
 */
export function allocateMcpPublicationSlug(collectionId: string): string {
  return createHash('sha256').update(collectionId, 'utf8').digest('hex').slice(0, 32);
}
