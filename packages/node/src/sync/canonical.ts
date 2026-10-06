/**
 * Browser-safe Sync canonical digest and effect-page URL expansion.
 *
 * No Node builtins. Node and MV3 must import this module for protocol identity.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { parseTemplate } from 'url-template';

import { isPrivateOrLocalLiteralHostname } from '../shared/private-or-local-literal-host.js';
import {
  canonicalJsonSnapshot,
  encodeCanonicalJson,
} from './canonical-json.js';

export { canonicalJsonSnapshot, encodeCanonicalJson } from './canonical-json.js';
export { subtreeDeleteSource, SUBTREE_OBSERVATION_EXTENSION } from './subtree-observation.js';

export const AUTHORITATIVE_EFFECT_MAX_BYTES = 262_144;
export const AUTHORITATIVE_EFFECT_PAGE_MAX_BYTES = 262_144;
export const AUTHORITATIVE_EFFECT_MAX_DEPTH = 32;
export const AUTHORITATIVE_EFFECT_MAX_MEMBERS = 10_000;
export const AUTHORITATIVE_EFFECT_SERIES_MAX_MEMBERS = 524_288;

export const EFFECT_PAGE_TEMPLATE_VARIABLES = Object.freeze(['effectId', 'pageNumber'] as const);

const credentialQueryNames = new Set([
  'access_token', 'apikey', 'api_key', 'authorization', 'credential', 'key',
  'password', 'secret', 'session', 'sessionid', 'session_id', 'sig', 'signature', 'token',
]);

function contentDigest(value: unknown, label: string): string {
  return formatContentDigest(sha256(new TextEncoder().encode(encodeCanonicalJson(value, label))));
}

function formatContentDigest(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `sha-256=:${btoa(binary)}:`;
}

/** Canonical digest used to bind a 0.2 effect to the immutable source Operation. */
export function canonicalOperationDigest(operation: unknown): string {
  return contentDigest(operation, 'Canonical Operation digest input');
}

/** Canonical digest over an effect with its self-referential effectDigest member omitted. */
export function canonicalAuthoritativeEffectDigest(effect: unknown): string {
  const snapshot = canonicalJsonSnapshot(effect, 'Canonical authoritative effect digest input');
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new TypeError('Canonical authoritative effect digest input must be a plain object.');
  }
  const { effectDigest: _effectDigest, ...digestInput } = snapshot as Record<string, unknown>;
  return contentDigest(digestInput, 'Canonical authoritative effect digest input');
}

export function canonicalAuthoritativeMemberDigest(members: unknown): string {
  const label = 'Canonical authoritative member digest input';
  if (!Array.isArray(members) || Object.getPrototypeOf(members) !== Array.prototype) {
    throw new TypeError(`${label} must be an ordinary array.`);
  }
  const length = Object.getOwnPropertyDescriptor(members, 'length')?.value as unknown;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0
    || length > AUTHORITATIVE_EFFECT_SERIES_MAX_MEMBERS) {
    throw new RangeError(`${label} exceeds the maximum paged member count.`);
  }
  if (Reflect.ownKeys(members).length !== length + 1) {
    throw new TypeError(`${label} arrays must be dense and have no extra properties.`);
  }
  // A member series is a flat string array, not a single effect JSON object.
  // Hash its canonical framing incrementally without cloning up to 524,288 IDs
  // or relaxing the generic/inline JSON depth and member budgets.
  const hash = sha256.create();
  const encoder = new TextEncoder();
  hash.update(encoder.encode('['));
  for (let index = 0; index < length; index += 1) {
    const member = Object.getOwnPropertyDescriptor(members, String(index));
    if (member === undefined || !member.enumerable || !('value' in member)
      || typeof member.value !== 'string') {
      throw new TypeError(`${label} must contain only dense string data properties.`);
    }
    hash.update(encoder.encode(`${index === 0 ? '' : ','}${JSON.stringify(member.value)}`));
  }
  hash.update(encoder.encode(']'));
  return formatContentDigest(hash.digest());
}

export function canonicalAuthoritativeEffectPageDigest(page: unknown): string {
  const snapshot = canonicalJsonSnapshot(page, 'Canonical authoritative effect page digest input');
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new TypeError('Canonical authoritative effect page digest input must be a plain object.');
  }
  const { pageDigest: _pageDigest, ...digestInput } = snapshot as Record<string, unknown>;
  return contentDigest(digestInput, 'Canonical authoritative effect page digest input');
}

export function assertAuthoritativeEffectPageUrlSafe(raw: string): void {
  const pageUrl = new URL(raw);
  if (pageUrl.protocol !== 'https:' || pageUrl.username !== '' || pageUrl.password !== ''
    || pageUrl.hash !== ''
    || [...pageUrl.searchParams.keys()].some((name) => credentialQueryNames.has(name.toLowerCase()))) {
    throw new TypeError('Authoritative Pull effect page URL must not contain credentials.');
  }
  if (isPrivateOrLocalLiteralHostname(pageUrl.hostname)) {
    throw new TypeError(
      'Expired Sync Cursor snapshotUrl must not target localhost or a private/local address.',
    );
  }
}

export function expandAuthoritativeEffectPageUrl(
  raw: string,
  effectId: string,
  pageNumber: number,
): string {
  if (typeof raw !== 'string') {
    throw new TypeError('Authoritative Pull effect page template must be a string.');
  }
  if (typeof effectId !== 'string' || effectId.length < 1 || effectId.length > 128
      || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 1_024) {
    throw new TypeError('Authoritative Pull effect page expansion variables are invalid.');
  }
  const variables = [...raw.matchAll(/\{([^{}]+)\}/gu)]
    .flatMap((match) => (match[1] ?? '').split(',')).sort();
  if (variables.length !== 2 || variables[0] !== 'effectId' || variables[1] !== 'pageNumber') {
    throw new TypeError('Authoritative Pull effect page template requires exactly effectId and pageNumber.');
  }
  const expanded = parseTemplate(raw).expand({ effectId, pageNumber: String(pageNumber) });
  assertAuthoritativeEffectPageUrlSafe(expanded);
  return expanded;
}
