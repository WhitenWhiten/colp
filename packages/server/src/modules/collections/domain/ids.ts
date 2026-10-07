import { randomBytes } from 'node:crypto';

/**
 * 16 random bytes → base64url opaque id (matches identity generateOpaqueId).
 * Kept local so collections does not depend on the identity module for IDs.
 */
export function generateOpaqueId(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * 128-bit opaque revision token (ADR-0010).
 * Same encoding as opaque ids; clients may only equality-match.
 */
export function generateRevisionToken(): string {
  return randomBytes(16).toString('base64url');
}

/** Strong HTTP entity-tag: quoted opaque revision. */
export function strongEntityTag(revision: string): string {
  return `"${revision}"`;
}
