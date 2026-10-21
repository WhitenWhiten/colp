import { sha256 } from '@noble/hashes/sha2.js';

import {
  canonicalFormOmitting,
  canonicalJsonSnapshot,
  encodeKnownCanonicalSnapshot,
} from './canonical-json.js';

function formatContentDigest(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `sha-256=:${btoa(binary)}:`;
}

function hashCanonical(encoded: string): string {
  return formatContentDigest(sha256(new TextEncoder().encode(encoded)));
}

function plainSnapshot(value: unknown, label: string): object {
  const snapshot = canonicalJsonSnapshot(value, label);
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return snapshot;
}

/**
 * One canonical snapshot shared by an effect digest and the full effect's
 * byte budget. Removing `effectDigest` changes the encoded bytes, so the
 * digest input is canonicalized separately and is not charged as the full
 * effect budget.
 */
export function effectCanonicalMaterial(effect: unknown): {
  readonly digest: string;
  readonly encodedEffect: string;
} {
  const label = 'Canonical authoritative effect digest input';
  const snapshot = plainSnapshot(effect, label);
  return {
    digest: hashCanonical(canonicalFormOmitting(snapshot, 'effectDigest', label)),
    encodedEffect: encodeKnownCanonicalSnapshot(snapshot, 'Canonical JSON input'),
  };
}

export function effectCanonicalDigest(effect: unknown): string {
  const label = 'Canonical authoritative effect digest input';
  const snapshot = plainSnapshot(effect, label);
  return hashCanonical(canonicalFormOmitting(snapshot, 'effectDigest', label));
}

export function effectPageCanonicalMaterial(page: unknown): {
  readonly digest: string;
  readonly encodedPage: string;
} {
  const label = 'Canonical authoritative effect page digest input';
  const snapshot = plainSnapshot(page, label);
  return {
    digest: hashCanonical(canonicalFormOmitting(snapshot, 'pageDigest', label)),
    encodedPage: encodeKnownCanonicalSnapshot(snapshot, 'Canonical JSON input'),
  };
}

export function effectPageCanonicalDigest(page: unknown): string {
  const label = 'Canonical authoritative effect page digest input';
  const snapshot = plainSnapshot(page, label);
  return hashCanonical(canonicalFormOmitting(snapshot, 'pageDigest', label));
}
