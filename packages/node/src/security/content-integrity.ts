import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import {
  exactOwnStringKeys,
  isPlainRecord,
  readOwnDataProperty,
  snapshotDenseArray,
} from './input-snapshot.js';

/**
 * Public Snapshot/Feed content-integrity header emission (SEC-0017).
 *
 * This module **emits** RFC 9530 `Content-Digest` and RFC 9421
 * `Signature-Input`/`Signature` header values from caller-supplied body bytes
 * and a precomputed 64-byte Ed25519 signature. It does **not**:
 * - generate signatures
 * - verify Ed25519 signatures cryptographically
 * - retrieve JWKS or Manifest keys
 *
 * Adapters that require authenticity MUST verify the signature (and key
 * material) before trusting the representation. Success disposition is
 * `headers_emitted`, not policy enforcement.
 */

export type ContentIntegrityResourceType = 'snapshot' | 'feed';
export type ContentIntegrityVisibility = 'public' | 'unlisted' | 'protected' | 'private';
export type ContentIntegrityKeySource = 'jwks' | 'manifest';

export interface ContentIntegrityRotationEvidence {
  readonly activeKeyId: string;
  readonly retainedKeyIds: readonly string[];
}

export interface ContentIntegrityInput {
  readonly resourceType: ContentIntegrityResourceType;
  readonly visibility: ContentIntegrityVisibility;
  readonly method: string;
  readonly targetUri: string;
  readonly contentType: string;
  /** Exact response octets, before transfer/content encoding. */
  readonly body: string | Uint8Array;
  /**
   * Exact Ed25519 signature octets (64 bytes). This helper does not sign and
   * does not cryptographically verify the signature; it only length-checks and
   * Base64-encodes the caller-supplied bytes into the Signature header.
   */
  readonly signature: Uint8Array;
  readonly algorithm: 'ed25519';
  readonly keySource: ContentIntegrityKeySource;
  readonly keyId: string;
  readonly rotation: ContentIntegrityRotationEvidence;
}

export type ContentIntegrityDenialReason = 'invalid_input';

export type ContentIntegrityDecision =
  | {
      readonly allowed: true;
      readonly disposition: 'not_applicable';
      readonly applicability: 'not_applicable';
      readonly reason: 'not_applicable';
    }
  | {
      readonly allowed: true;
      /** Headers were serialized; cryptographic verification is adapter-owned. */
      readonly disposition: 'headers_emitted';
      readonly applicability: 'applicable';
      readonly reason: 'content_integrity';
      readonly headers: Readonly<{
        'Content-Digest': string;
        'Signature-Input': string;
        Signature: string;
      }>;
    }
  | {
      readonly allowed: false;
      readonly reason: ContentIntegrityDenialReason;
    };

const NOT_APPLICABLE = Object.freeze({
  allowed: true,
  disposition: 'not_applicable',
  applicability: 'not_applicable',
  reason: 'not_applicable',
} as const);

const INVALID_INPUT = Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const CONTROLS = /[\u0000-\u001f\u007f]/u;
const ASCII_VISIBLE = /^[\x20-\x7e]+$/u;
const MAX_KEY_ID_LENGTH = 128;
const MAX_URI_LENGTH = 4_096;

function bodyBytes(value: unknown): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (!(value instanceof Uint8Array) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    throw new TypeError('body must be a string or plain Uint8Array');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (descriptor !== undefined && 'get' in descriptor) throw new TypeError('Invalid body bytes');
  return Uint8Array.prototype.slice.call(value);
}

function keyId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_ID_LENGTH || !TOKEN.test(value)) {
    throw new TypeError(`${label} must be a bounded HTTP token`);
  }
  return value;
}

function signatureBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    throw new TypeError('signature must be raw Ed25519 bytes');
  }
  const bytes = Uint8Array.prototype.slice.call(value);
  if (bytes.length !== 64) throw new TypeError('signature must contain exactly 64 Ed25519 bytes');
  return bytes;
}

function validateMethod(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !ASCII_VISIBLE.test(value) || !TOKEN.test(value) || value !== value.toUpperCase()) {
    throw new TypeError('method must be a canonical uppercase HTTP token');
  }
  return value;
}

function validateTargetUri(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_URI_LENGTH ||
    !ASCII_VISIBLE.test(value) ||
    CONTROLS.test(value) ||
    /\s/u.test(value)
  ) {
    throw new TypeError('targetUri must be an ASCII absolute URI');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('targetUri must be an absolute HTTPS URI');
  }
  if (/%(?:0[dD]|0[aA])/u.test(value) || parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hostname === '') {
    throw new TypeError('targetUri must be an absolute HTTPS URI without credentials');
  }
  return value;
}

function validateContentType(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    !ASCII_VISIBLE.test(value) ||
    CONTROLS.test(value)
  ) {
    throw new TypeError('contentType must be an ASCII media type');
  }
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  if (!new RegExp(`^${token}/${token}(?:\\s*;\\s*${token}\\s*=\\s*${token})*$`, 'u').test(value)) {
    throw new TypeError('contentType must be a valid media type');
  }
  return value;
}

function snapshotInput(input: unknown): {
  readonly method: string;
  readonly targetUri: string;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly signature: Uint8Array;
  readonly keyId: string;
  readonly keySource: ContentIntegrityKeySource;
  readonly rotation: ContentIntegrityRotationEvidence;
} {
  if (!isPlainRecord(input)) throw new TypeError('Integrity input must be a plain object');
  exactOwnStringKeys(
    input,
    [
      'resourceType',
      'visibility',
      'method',
      'targetUri',
      'contentType',
      'body',
      'signature',
      'algorithm',
      'keySource',
      'keyId',
      'rotation',
    ],
    'content-integrity input',
  );
  const method = validateMethod(readOwnDataProperty(input, 'method').value);
  const targetUri = validateTargetUri(readOwnDataProperty(input, 'targetUri').value);
  const contentType = validateContentType(readOwnDataProperty(input, 'contentType').value);
  const body = bodyBytes(readOwnDataProperty(input, 'body').value);
  const signature = signatureBytes(readOwnDataProperty(input, 'signature').value);
  if (readOwnDataProperty(input, 'algorithm').value !== 'ed25519') throw new TypeError('algorithm must be ed25519');
  const keySource = readOwnDataProperty(input, 'keySource').value;
  if (keySource !== 'jwks' && keySource !== 'manifest') throw new TypeError('keySource must be jwks or manifest');
  const signerKeyId = keyId(readOwnDataProperty(input, 'keyId').value, 'keyId');
  const rotationValue = readOwnDataProperty(input, 'rotation').value;
  if (!isPlainRecord(rotationValue)) throw new TypeError('rotation evidence must be a plain object');
  exactOwnStringKeys(rotationValue, ['activeKeyId', 'retainedKeyIds'], 'rotation evidence');
  const activeKeyId = keyId(readOwnDataProperty(rotationValue, 'activeKeyId').value, 'activeKeyId');
  const retained = snapshotDenseArray(readOwnDataProperty(rotationValue, 'retainedKeyIds').value, 'retainedKeyIds').map(
    (entry) => keyId(entry, 'retainedKeyId'),
  );
  if (retained.length === 0 || new Set(retained).size !== retained.length || new Set([activeKeyId, ...retained]).size !== retained.length + 1) {
    throw new TypeError('rotation must retain non-empty distinct old key IDs and the active key');
  }
  if (signerKeyId !== activeKeyId) throw new TypeError('keyId must be the active rotation key');
  return Object.freeze({ method, targetUri, contentType, body, signature, keyId: signerKeyId, keySource, rotation: Object.freeze({ activeKeyId, retainedKeyIds: Object.freeze([...retained]) }) });
}

/**
 * Emit RFC 9530 / RFC 9421 content-integrity headers for a public Snapshot or Feed.
 *
 * Does **not** cryptographically verify the caller-supplied Ed25519 signature.
 * On success, `disposition` is `'headers_emitted'`.
 */
export function emitContentIntegrityHeaders(input: unknown): ContentIntegrityDecision {
  if (!isPlainRecord(input)) return INVALID_INPUT;
  try {
    const resourceType = readOwnDataProperty(input, 'resourceType');
    const visibility = readOwnDataProperty(input, 'visibility');
    // Do not inspect possible secret fields until the public applicability gate passes.
    // Applicability is only decidable from own data fields. Missing or
    // inherited discriminators are malformed input, while an explicit
    // non-public/other resource remains a clean not-applicable result.
    if (!resourceType.found || !visibility.found) return INVALID_INPUT;
    if (
      visibility.value !== 'public' &&
      visibility.value !== 'unlisted' &&
      visibility.value !== 'protected' &&
      visibility.value !== 'private'
    ) {
      return INVALID_INPUT;
    }
    if (visibility.value !== 'public' || (resourceType.value !== 'snapshot' && resourceType.value !== 'feed')) return NOT_APPLICABLE;
    const snapshot = snapshotInput(input);
    const digest = createHash('sha256').update(snapshot.body).digest('base64');
    const encodedSignature = Buffer.from(snapshot.signature).toString('base64');
    const signatureInput = `sig1=("@method" "@target-uri" "content-digest" "content-type");keyid="${snapshot.keyId}";alg="ed25519"`;
    return Object.freeze({
      allowed: true,
      disposition: 'headers_emitted',
      applicability: 'applicable',
      reason: 'content_integrity',
      headers: Object.freeze({
        'Content-Digest': `sha-256=:${digest}:`,
        'Signature-Input': signatureInput,
        Signature: `sig1=:${encodedSignature}:`,
      }),
    });
  } catch {
    return INVALID_INPUT;
  }
}

/** Alias of {@link emitContentIntegrityHeaders}. */
export const serializeContentIntegrity = emitContentIntegrityHeaders;
