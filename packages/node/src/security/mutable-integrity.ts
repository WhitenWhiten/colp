import { types as nodeTypes } from 'node:util';

import {
  exactOwnStringKeys,
  isPlainRecord,
  readOwnDataProperty,
  type OwnDataProperty,
} from './input-snapshot.js';
import { assertUnixSeconds } from './time-units.js';

export const MUTABLE_INTEGRITY_COMPONENTS = Object.freeze([
  '@status',
  'created',
  'expires',
  'etag',
  'protocol-version',
] as const);
export const MAX_MUTABLE_STALE_SECONDS = 86_400;

export type MutableIntegrityResourceType = 'mutable' | 'historical-release';

export interface MutableIntegrityClaims {
  readonly '@status': number;
  /**
   * Claim creation time (NumericDate).
   * Unit: {@link import('./time-units.js').NumericDateSeconds} (Unix whole seconds).
   */
  readonly created: number;
  /**
   * Claim expiry time (NumericDate).
   * Unit: {@link import('./time-units.js').NumericDateSeconds} (Unix whole seconds).
   */
  readonly expires: number;
  readonly etag: string;
  readonly 'protocol-version'?: string;
  readonly protocolVersion?: string;
}

export interface MutableIntegritySignatureVerificationPort {
  /** Verify the canonical claim envelope together with its exact resource URI.
   *
   * The URI is passed as a separate, frozen binding context so adapters can
   * include it in their signature input without mutating the five-component
   * claims object. A verifier that ignores this context is adapter-invalid: a
   * signature must never be replayable at another resource URI.
   */
  verify(
    claims: Readonly<Record<string, unknown>>,
    binding: Readonly<{ readonly uri: string }>,
  ): Promise<boolean>;
}

export interface MutableIntegrityClockPort {
  /**
   * Authoritative wall time.
   * Unit: {@link import('./time-units.js').UnixSeconds} (whole seconds).
   */
  now(): number;
}

export interface MutableIntegrityPorts {
  readonly signatureVerification: MutableIntegritySignatureVerificationPort;
  readonly clock: MutableIntegrityClockPort;
}

export interface MutableIntegrityInput {
  readonly resourceType: MutableIntegrityResourceType;
  readonly uri?: string;
  readonly immutable?: boolean;
  readonly releaseId?: string;
  readonly revision?: string;
  readonly claims?: MutableIntegrityClaims;
  readonly maxStaleSeconds?: number;
  /** Optional convenience for adapters; the second function argument wins. */
  readonly ports?: MutableIntegrityPorts;
}

export type MutableIntegrityDenialReason =
  | 'invalid_input'
  | 'signature_invalid'
  | 'future'
  | 'stale'
  | 'expired'
  | 'port_failure';

export type MutableIntegrityDecision =
  | { readonly allowed: true; readonly disposition: 'not_applicable'; readonly applicability: 'not_applicable'; readonly reason: 'not_applicable' }
  /** Cryptographic verify + freshness via injected ports (true enforcement). */
  | { readonly allowed: true; readonly disposition: 'enforced'; readonly applicability: 'applicable'; readonly reason: 'mutable_integrity' }
  /**
   * Historical Release path: immutability flag, Release ID / Revision presence,
   * and canonical HTTPS URI shape only — no signature verification.
   */
  | { readonly allowed: true; readonly disposition: 'shape_validated'; readonly applicability: 'applicable'; readonly reason: 'historical_release' }
  | { readonly allowed: false; readonly reason: MutableIntegrityDenialReason };

const NOT_APPLICABLE = Object.freeze({ allowed: true, disposition: 'not_applicable', applicability: 'not_applicable', reason: 'not_applicable' } as const);
const DENIALS = Object.freeze(Object.fromEntries(
  ['invalid_input', 'signature_invalid', 'future', 'stale', 'expired', 'port_failure'].map((reason) => [reason, Object.freeze({ allowed: false, reason })]),
) as Record<MutableIntegrityDenialReason, MutableIntegrityDecision>);

function denied(reason: MutableIntegrityDenialReason): MutableIntegrityDecision { return DENIALS[reason]; }

/**
 * Local wrapper: throw when the host is not a plain record (specialized
 * mutable-integrity error path), otherwise delegate to shared own-data read.
 */
function ownData(value: unknown, key: PropertyKey): OwnDataProperty {
  if (!isPlainRecord(value)) throw new TypeError('expected plain record');
  return readOwnDataProperty(value, key);
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || !/^[\x21-\x7e]+$/u.test(value)) throw new TypeError('invalid text');
  return value;
}

function safeInteger(value: unknown): number {
  if (typeof value !== 'number') throw new TypeError('invalid NumericDate');
  try {
    assertUnixSeconds(value, 'NumericDate');
  } catch {
    throw new TypeError('invalid NumericDate');
  }
  return value;
}

function validateUri(value: unknown, releaseId?: string, revision?: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || !/^https:\/\/[\x21-\x7e]+$/u.test(value) || value.includes('%') || value.includes('\\')) throw new TypeError('invalid URI');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new TypeError('invalid URI'); }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '' || parsed.hostname === '' || parsed.hostname.endsWith('.')) throw new TypeError('invalid URI');
  if (parsed.toString() !== value || /:443(?:\/|$)/u.test(value)) throw new TypeError('ambiguous URI');
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.some((part) => part === '.' || part === '..')) throw new TypeError('ambiguous URI');
  if (releaseId !== undefined && (!segments.includes(releaseId) || !segments.includes(revision!))) throw new TypeError('release identifiers are not in URI');
  return value;
}

function snapshotClaims(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) throw new TypeError('claims must be plain');
  exactOwnStringKeys(value, ['@status', 'created', 'expires', 'etag', 'protocol-version', 'protocolVersion'], 'claims');
  // The signed envelope has a canonical five-component order.  Preserve this
  // requirement before constructing the frozen snapshot so a verifier cannot
  // accidentally accept a reordered claim set.
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 5 || keys[0] !== '@status' || keys[1] !== 'created' || keys[2] !== 'expires' || keys[3] !== 'etag' || (keys[4] !== 'protocol-version' && keys[4] !== 'protocolVersion')) throw new TypeError('claims must use canonical order');
  const statusField = ownData(value, '@status');
  const createdField = ownData(value, 'created');
  const expiresField = ownData(value, 'expires');
  const etagField = ownData(value, 'etag');
  const protocolDash = ownData(value, 'protocol-version');
  const protocolCamel = ownData(value, 'protocolVersion');
  if (!statusField.found || !createdField.found || !expiresField.found || !etagField.found || protocolDash.found === protocolCamel.found) throw new TypeError('claims must contain exactly five components');
  const status = safeInteger(statusField.value);
  if (status < 100 || status > 599) throw new TypeError('invalid status');
  const created = safeInteger(createdField.value);
  const expires = safeInteger(expiresField.value);
  if (expires <= created) throw new TypeError('expires must be greater than created');
  const etag = boundedText(etagField.value);
  const protocol = boundedText(protocolDash.found ? protocolDash.value : protocolCamel.value);
  const result: Record<string, unknown> = {
    '@status': status,
    created,
    expires,
    etag,
    [protocolDash.found ? 'protocol-version' : 'protocolVersion']: protocol,
  };
  return Object.freeze(result);
}

function snapshotMethod(ports: unknown, portName: 'signatureVerification' | 'clock', methodName: 'verify' | 'now'): (...args: unknown[]) => unknown {
  const portField = ownData(ports, portName);
  if (!portField.found || !isPlainRecord(portField.value)) throw new TypeError('port missing');
  const port = portField.value;
  let owner: object | null = port;
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, methodName);
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) throw new TypeError('invalid port method');
      const method = descriptor.value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => Reflect.apply(method, port, args);
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  throw new TypeError('port method missing');
}

async function nativePromise(value: unknown): Promise<unknown> {
  if (!nodeTypes.isPromise(value) || nodeTypes.isProxy(value)) throw new TypeError('port must return native Promise');
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null || nodeTypes.isProxy(prototype) || Object.getOwnPropertyDescriptor(value, 'constructor') !== undefined) throw new TypeError('port must return native Promise');
  const thenDescriptor = Object.getOwnPropertyDescriptor(prototype, 'then');
  if (!thenDescriptor || !('value' in thenDescriptor) || typeof thenDescriptor.value !== 'function' || !Function.prototype.toString.call(thenDescriptor.value).includes('[native code]')) throw new TypeError('port must return native Promise');
  return new Promise((resolve, reject) => Reflect.apply(thenDescriptor.value, value, [resolve, reject]));
}

export async function enforceMutableResourceIntegrity(portsOrInput: unknown, inputOrPorts?: unknown): Promise<MutableIntegrityDecision> {
  // Security guards in this package take injected ports first.  The single
  // argument form keeps adapter-local ports convenient, while accepting the
  // historical input-first spelling avoids an accidental trust-boundary fork.
  let input: unknown = inputOrPorts === undefined ? portsOrInput : inputOrPorts;
  let injectedPorts: unknown = inputOrPorts === undefined ? undefined : portsOrInput;
  try {
    if (inputOrPorts !== undefined && isPlainRecord(portsOrInput) && ownData(portsOrInput, 'resourceType').found) {
      input = portsOrInput;
      injectedPorts = inputOrPorts;
    }
  } catch {
    return denied('invalid_input');
  }
  if (!isPlainRecord(input)) return denied('invalid_input');
  try {
    exactOwnStringKeys(
      input,
      ['resourceType', 'uri', 'immutable', 'releaseId', 'revision', 'claims', 'maxStaleSeconds', 'ports'],
      'mutable integrity input',
    );
    const kind = ownData(input, 'resourceType');
    if (!kind.found || kind.value !== 'mutable' && kind.value !== 'historical-release') return NOT_APPLICABLE;
    const uriField = ownData(input, 'uri');
    if (!uriField.found) throw new TypeError('URI required');
    validateUri(uriField.value);
    if (kind.value === 'historical-release') {
      // Shape/URI validation only: immutable flag, releaseId, revision, and
      // canonical HTTPS URI containing those identifiers. No crypto port.
      if (ownData(input, 'immutable').value !== true) throw new TypeError('historical resource must be immutable');
      const release = boundedText(ownData(input, 'releaseId').value);
      const revision = boundedText(ownData(input, 'revision').value);
      validateUri(uriField.value, release, revision);
      return Object.freeze({ allowed: true, disposition: 'shape_validated', applicability: 'applicable', reason: 'historical_release' });
    }
    if (ownData(input, 'immutable').found || ownData(input, 'releaseId').found || ownData(input, 'revision').found) throw new TypeError('mutable resource has historical fields');
    const ports = injectedPorts ?? ownData(input, 'ports').value;
    const claims = snapshotClaims(ownData(input, 'claims').value);
    const maxStaleField = ownData(input, 'maxStaleSeconds');
    const maxStale = safeInteger(maxStaleField.found ? maxStaleField.value : ownData(ports, 'maxStaleSeconds').value);
    if (maxStale <= 0 || maxStale > MAX_MUTABLE_STALE_SECONDS) throw new TypeError('invalid staleness bound');
    let verify: (claims?: unknown, binding?: unknown) => unknown;
    let nowMethod: (arg?: unknown) => unknown;
    try {
      verify = snapshotMethod(ports, 'signatureVerification', 'verify');
      nowMethod = snapshotMethod(ports, 'clock', 'now');
    } catch {
      return denied('port_failure');
    }
    let verifiedResult: unknown;
    try {
      // Bind verification to the exact resource URI.  Keeping the URI out of
      // the five-component claims object preserves canonical claim ordering,
      // while the frozen context gives the verifier an unambiguous signature
      // input binding and prevents cross-resource replay.
      verifiedResult = await nativePromise(verify(claims, Object.freeze({ uri: uriField.value as string })));
    } catch {
      return denied('port_failure');
    }
    if (typeof verifiedResult !== 'boolean') return denied('port_failure');
    if (!verifiedResult) return denied('signature_invalid');
    // Read freshness only after successful signature verification.  This
    // ordering closes the verify/clock TOCTOU window and avoids consulting a
    // clock for untrusted signatures.
    let nowValue: number;
    try {
      nowValue = safeInteger(nowMethod());
    } catch {
      return denied('port_failure');
    }
    if (nowValue < (claims.created as number)) return denied('future');
    if (nowValue >= (claims.expires as number)) return denied('expired');
    if (nowValue - (claims.created as number) > maxStale) return denied('stale');
    return Object.freeze({ allowed: true, disposition: 'enforced', applicability: 'applicable', reason: 'mutable_integrity' });
  } catch (error) {
    return denied('invalid_input');
  }
}

export const enforceMutableIntegrity = enforceMutableResourceIntegrity;
export const verifyMutableResourceIntegrity = enforceMutableResourceIntegrity;
