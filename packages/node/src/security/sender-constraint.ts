import { createHash, timingSafeEqual } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import { assertUnixSeconds } from './time-units.js';

export const DPOP_PROOF_MAX_AGE_SECONDS = 300 as const;

export type SenderConstraintOperation = 'key' | 'acl' | 'public-exposure' | 'purge' | 'other';
export type SenderConstraintLocation = 'remote' | 'local';
export type SenderConstraintApplicability = 'applicable' | 'not_applicable';
export type SenderConstraintMode = 'dpop' | 'mtls' | 'not_applicable';

export interface SenderConstraintTokenConfirmation {
  readonly jkt?: string;
  readonly 'x5t#S256'?: string;
}

export interface SenderConstraintAccessTokenEvidence {
  /** The exact access-token octets represented as a JavaScript string. */
  readonly value: string;
  readonly cnf: SenderConstraintTokenConfirmation;
}

export interface DpopRequestEvidence {
  /** Opaque proof serialization. Signature and proof-key verification belong to the verifier port. */
  readonly proof: string;
  /** Canonical, case-sensitive HTTP method. */
  readonly method: string;
  /** Canonical absolute DPoP target URI, without query or fragment. */
  readonly targetUri: string;
}

export interface MtlsSenderConstraintEvidence {
  /** Adapters must use evidence obtained directly from the authenticated TLS session. */
  readonly source: 'tls-session' | 'proxy-assertion';
  readonly authenticated: boolean;
  readonly presentedCertificateThumbprintSha256: string;
}

export interface SenderConstraintInput {
  readonly operation: SenderConstraintOperation;
  readonly location: SenderConstraintLocation;
  readonly applicability: SenderConstraintApplicability;
  readonly mode: SenderConstraintMode;
  readonly accessToken?: SenderConstraintAccessTokenEvidence;
  readonly dpop?: DpopRequestEvidence;
  readonly mtls?: MtlsSenderConstraintEvidence;
}

export interface DpopProofVerificationCheck {
  readonly proof: string;
  readonly method: string;
  readonly targetUri: string;
  readonly accessTokenHash: string;
}

export type DpopProofVerification =
  | { readonly valid: false }
  | {
      readonly valid: true;
      readonly method: string;
      readonly targetUri: string;
      readonly accessTokenHash: string;
      readonly jwkThumbprint: string;
      readonly jti: string;
      /**
       * Proof `iat`.
       * Unit: {@link import('./time-units.js').UnixSeconds} (whole seconds).
       */
      readonly issuedAt: number;
    };

export interface DpopProofVerificationPort {
  /** Verify the proof signature and establish all returned claims from the signed proof. */
  verify(check: DpopProofVerificationCheck): Promise<DpopProofVerification>;
}

export interface DpopReplayConsumptionCheck {
  readonly jti: string;
  readonly jwkThumbprint: string;
  /**
   * Proof `iat`.
   * Unit: {@link import('./time-units.js').UnixSeconds} (whole seconds).
   */
  readonly issuedAt: number;
  /**
   * Observation time for freshness checks.
   * Unit: {@link import('./time-units.js').UnixSeconds} (whole seconds).
   */
  readonly observedAt: number;
  readonly maxAgeSeconds: typeof DPOP_PROOF_MAX_AGE_SECONDS;
}

export interface DpopReplayPort {
  /**
   * In one atomic operation, recheck the supplied inclusive freshness window
   * and consume the (jwkThumbprint, jti) pair exactly once.
   */
  consume(check: DpopReplayConsumptionCheck): Promise<boolean>;
}

export interface SenderConstraintClockPort {
  /**
   * Authoritative wall time.
   * Unit: {@link import('./time-units.js').UnixSeconds} (whole seconds).
   */
  now(): number;
}

export interface SenderConstraintPorts {
  readonly dpopProof?: DpopProofVerificationPort;
  readonly dpopReplay?: DpopReplayPort;
  readonly clock?: SenderConstraintClockPort;
}

export type SenderConstraintDenialReason =
  | 'invalid_input'
  | 'applicability_mismatch'
  | 'sender_constraint_required'
  | 'mode_conflict'
  | 'proof_invalid'
  | 'binding_mismatch'
  | 'replay_or_stale'
  | 'tls_evidence_invalid'
  | 'certificate_mismatch'
  | 'port_failure';

export type SenderConstraintDecision =
  | {
      readonly allowed: true;
      readonly disposition: 'not_applicable';
      readonly applicability: 'not_applicable';
      readonly mode: 'not_applicable';
      readonly reason: 'not_applicable';
    }
  | {
      readonly allowed: true;
      readonly disposition: 'enforced';
      readonly applicability: 'applicable';
      readonly mode: 'dpop' | 'mtls';
      readonly reason: 'sender_constrained';
    }
  | {
      readonly allowed: false;
      readonly disposition: 'denied';
      readonly reason: SenderConstraintDenialReason;
    };

interface OwnField {
  readonly found: boolean;
  readonly value?: unknown;
}

interface ClassificationSnapshot {
  readonly operation: SenderConstraintOperation;
  readonly location: SenderConstraintLocation;
  readonly applicability: SenderConstraintApplicability;
  readonly mode: SenderConstraintMode;
  readonly accessToken: OwnField;
  readonly dpop: OwnField;
  readonly mtls: OwnField;
}

interface TokenSnapshot {
  readonly value: string;
  readonly jkt: OwnField;
  readonly certificateThumbprint: OwnField;
}

interface DpopSnapshot {
  readonly token: TokenSnapshot;
  readonly proof: string;
  readonly method: string;
  readonly targetUri: string;
}

interface MtlsSnapshot {
  readonly token: TokenSnapshot;
  readonly source: string;
  readonly authenticated: boolean;
  readonly presentedCertificateThumbprintSha256: string;
}

class ModeConflictError extends TypeError {}

const operations = new Set<SenderConstraintOperation>([
  'key',
  'acl',
  'public-exposure',
  'purge',
  'other',
]);
const highRiskOperations = new Set<SenderConstraintOperation>([
  'key',
  'acl',
  'public-exposure',
  'purge',
]);
const locations = new Set<SenderConstraintLocation>(['remote', 'local']);
const applicabilities = new Set<SenderConstraintApplicability>(['applicable', 'not_applicable']);
const modes = new Set<SenderConstraintMode>(['dpop', 'mtls', 'not_applicable']);
const controlCharacters = /[\u0000-\u001f\u007f]/u;
const unpairedSurrogate = /[\uD800-\uDFFF]/u;
const uppercaseHttpMethod = /^[!#$%&'*+.^_`|~0-9A-Z-]+$/u;
const sha256Base64Url = /^[A-Za-z0-9_-]{43}$/u;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_PROOF_LENGTH = 32_768;
const MAX_TARGET_URI_LENGTH = 8_192;
const MAX_JTI_LENGTH = 256;
const MAX_UNIX_TIME_SECONDS = 253_402_300_799;

const notApplicableDecision = Object.freeze({
  allowed: true,
  disposition: 'not_applicable',
  applicability: 'not_applicable',
  mode: 'not_applicable',
  reason: 'not_applicable',
} as const);
const enforcedDecisions = Object.freeze({
  dpop: Object.freeze({
    allowed: true,
    disposition: 'enforced',
    applicability: 'applicable',
    mode: 'dpop',
    reason: 'sender_constrained',
  } as const),
  mtls: Object.freeze({
    allowed: true,
    disposition: 'enforced',
    applicability: 'applicable',
    mode: 'mtls',
    reason: 'sender_constrained',
  } as const),
});
const denialDecisions = Object.freeze(
  Object.fromEntries(
    [
      'invalid_input',
      'applicability_mismatch',
      'sender_constraint_required',
      'mode_conflict',
      'proof_invalid',
      'binding_mismatch',
      'replay_or_stale',
      'tls_evidence_invalid',
      'certificate_mismatch',
      'port_failure',
    ].map((reason) => [reason, Object.freeze({ allowed: false, disposition: 'denied', reason })]),
  ) as Record<SenderConstraintDenialReason, SenderConstraintDecision>,
);

function denied(reason: SenderConstraintDenialReason): SenderConstraintDecision {
  return denialDecisions[reason];
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectProxy(value: unknown, name: string): void {
  if (nodeTypes.isProxy(value)) throw new TypeError(`${name} must not be a Proxy`);
}

function ownField(value: unknown, key: PropertyKey, name: string): OwnField {
  if (!isRecord(value)) throw new TypeError(`${name} must be supplied in an object`);
  rejectProxy(value, name);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return Object.freeze({ found: false });
  if (!('value' in descriptor)) {
    throw new TypeError(`${name}.${String(key)} must be an own data property`);
  }
  return Object.freeze({ found: true, value: descriptor.value });
}

function requiredField(value: unknown, key: PropertyKey, name: string): unknown {
  const field = ownField(value, key, name);
  if (!field.found) throw new TypeError(`${name}.${String(key)} is required`);
  return field.value;
}

function boundedString(value: unknown, name: string, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    unpairedSurrogate.test(value) ||
    controlCharacters.test(value)
  ) {
    throw new TypeError(`${name} must be a bounded non-empty string without control characters`);
  }
  return value;
}

function requireExactOwnKeys(
  value: unknown,
  expectedKeys: readonly (string | symbol)[],
  name: string,
): void {
  if (!isRecord(value)) throw new TypeError(`${name} must be supplied in an object`);
  rejectProxy(value, name);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((expected) => !keys.includes(expected))
  ) {
    throw new ModeConflictError(`${name} contains conflicting confirmation methods`);
  }
}

function thumbprint(value: unknown, name: string): string {
  if (typeof value !== 'string' || !sha256Base64Url.test(value)) {
    throw new TypeError(`${name} must be an unpadded base64url SHA-256 value`);
  }
  return value;
}

function safeUnixTime(value: unknown, name: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be a bounded non-negative Unix timestamp`);
  }
  try {
    assertUnixSeconds(value, name);
  } catch {
    throw new TypeError(`${name} must be a bounded non-negative Unix timestamp`);
  }
  if (value < 0 || value > MAX_UNIX_TIME_SECONDS) {
    throw new TypeError(`${name} must be a bounded non-negative Unix timestamp`);
  }
  return value;
}

function snapshotClassification(input: SenderConstraintInput): ClassificationSnapshot {
  const operation = requiredField(input, 'operation', 'sender constraint input');
  const location = requiredField(input, 'location', 'sender constraint input');
  const applicability = requiredField(input, 'applicability', 'sender constraint input');
  const mode = requiredField(input, 'mode', 'sender constraint input');
  if (typeof operation !== 'string' || !operations.has(operation as SenderConstraintOperation)) {
    throw new TypeError('Unknown sender-constraint operation');
  }
  if (typeof location !== 'string' || !locations.has(location as SenderConstraintLocation)) {
    throw new TypeError('Unknown sender-constraint location');
  }
  if (
    typeof applicability !== 'string' ||
    !applicabilities.has(applicability as SenderConstraintApplicability)
  ) {
    throw new TypeError('Unknown sender-constraint applicability');
  }
  if (typeof mode !== 'string' || !modes.has(mode as SenderConstraintMode)) {
    throw new TypeError('Unknown sender-constraint mode');
  }
  return Object.freeze({
    operation: operation as SenderConstraintOperation,
    location: location as SenderConstraintLocation,
    applicability: applicability as SenderConstraintApplicability,
    mode: mode as SenderConstraintMode,
    accessToken: ownField(input, 'accessToken', 'sender constraint input'),
    dpop: ownField(input, 'dpop', 'sender constraint input'),
    mtls: ownField(input, 'mtls', 'sender constraint input'),
  });
}

function snapshotToken(value: unknown): TokenSnapshot {
  const tokenValue = boundedString(
    requiredField(value, 'value', 'access token evidence'),
    'access token',
    MAX_TOKEN_LENGTH,
  );
  const confirmation = requiredField(value, 'cnf', 'access token evidence');
  if (!isRecord(confirmation)) {
    throw new TypeError('access token confirmation must be supplied in an object');
  }
  return Object.freeze({
    value: tokenValue,
    jkt: ownField(confirmation, 'jkt', 'access token confirmation'),
    certificateThumbprint: ownField(
      confirmation,
      'x5t#S256',
      'access token confirmation',
    ),
  });
}

function canonicalMethod(value: unknown): string {
  const method = boundedString(value, 'DPoP request method', 64);
  if (!uppercaseHttpMethod.test(method)) {
    throw new TypeError('DPoP request method must be a canonical uppercase HTTP method');
  }
  return method;
}

function canonicalTargetUri(value: unknown): string {
  const targetUri = boundedString(value, 'DPoP target URI', MAX_TARGET_URI_LENGTH);
  if (
    targetUri.includes('\\') ||
    targetUri.includes('%') ||
    targetUri.includes('?') ||
    targetUri.includes('#')
  ) {
    throw new TypeError('DPoP target URI contains normalization-sensitive characters');
  }
  let parsed: URL;
  try {
    parsed = new URL(targetUri);
  } catch {
    throw new TypeError('DPoP target URI must be an absolute URI');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length !== 0 ||
    parsed.password.length !== 0 ||
    parsed.hostname.endsWith('.') ||
    parsed.search.length !== 0 ||
    parsed.hash.length !== 0 ||
    parsed.href !== targetUri
  ) {
    throw new TypeError('DPoP target URI must use its unambiguous canonical HTTPS form');
  }
  return targetUri;
}

function snapshotDpop(classification: ClassificationSnapshot): DpopSnapshot {
  if (!classification.accessToken.found || !classification.dpop.found) {
    throw new TypeError('DPoP mode requires token and proof evidence');
  }
  const token = snapshotToken(classification.accessToken.value);
  const confirmation = requiredField(
    classification.accessToken.value,
    'cnf',
    'access token evidence',
  );
  requireExactOwnKeys(confirmation, ['jkt'], 'access token confirmation');
  if (token.certificateThumbprint.found) {
    throw new ModeConflictError('DPoP mode conflicts with x5t#S256 token confirmation');
  }
  if (!token.jkt.found) {
    throw new TypeError('DPoP mode requires exactly the jkt token confirmation');
  }
  thumbprint(token.jkt.value, 'token cnf.jkt');
  const evidence = classification.dpop.value;
  return Object.freeze({
    token,
    proof: boundedString(requiredField(evidence, 'proof', 'DPoP evidence'), 'DPoP proof', MAX_PROOF_LENGTH),
    method: canonicalMethod(requiredField(evidence, 'method', 'DPoP evidence')),
    targetUri: canonicalTargetUri(requiredField(evidence, 'targetUri', 'DPoP evidence')),
  });
}

function snapshotMtls(classification: ClassificationSnapshot): MtlsSnapshot {
  if (!classification.accessToken.found || !classification.mtls.found) {
    throw new TypeError('mTLS mode requires token and TLS evidence');
  }
  const token = snapshotToken(classification.accessToken.value);
  const confirmation = requiredField(
    classification.accessToken.value,
    'cnf',
    'access token evidence',
  );
  requireExactOwnKeys(confirmation, ['x5t#S256'], 'access token confirmation');
  if (token.jkt.found) {
    throw new ModeConflictError('mTLS mode conflicts with jkt token confirmation');
  }
  if (!token.certificateThumbprint.found) {
    throw new TypeError('mTLS mode requires exactly the x5t#S256 token confirmation');
  }
  thumbprint(token.certificateThumbprint.value, 'token cnf x5t#S256');
  const evidence = classification.mtls.value;
  const source = requiredField(evidence, 'source', 'mTLS evidence');
  const authenticated = requiredField(evidence, 'authenticated', 'mTLS evidence');
  if (typeof source !== 'string' || typeof authenticated !== 'boolean') {
    throw new TypeError('mTLS evidence source and authentication state are required');
  }
  return Object.freeze({
    token,
    source,
    authenticated,
    presentedCertificateThumbprintSha256: thumbprint(
      requiredField(evidence, 'presentedCertificateThumbprintSha256', 'mTLS evidence'),
      'presented certificate thumbprint',
    ),
  });
}

function secretEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'ascii');
  const rightBytes = Buffer.from(right, 'ascii');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function accessTokenHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function snapshotPortMethod(
  ports: unknown,
  portName: keyof SenderConstraintPorts,
  methodName: string,
): (input?: unknown) => unknown {
  const portField = ownField(ports, portName, 'sender constraint ports');
  if (!portField.found || !isRecord(portField.value)) {
    throw new TypeError(`sender constraint ports.${portName} is required`);
  }
  const port = portField.value;
  rejectProxy(port, `sender constraint ports.${portName}`);

  let owner: object | null = port;
  while (owner !== null && owner !== Object.prototype) {
    rejectProxy(owner, `sender constraint ports.${portName} prototype`);
    const parent = Object.getPrototypeOf(owner) as object | null;
    if (owner !== port && parent === null) break;
    const descriptor = Object.getOwnPropertyDescriptor(owner, methodName);
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new TypeError(`sender constraint ports.${portName}.${methodName} must be a data method`);
      }
      const method = descriptor.value as (input?: unknown) => unknown;
      rejectProxy(method, `sender constraint ports.${portName}.${methodName}`);
      return (input?: unknown) => Reflect.apply(method, port, input === undefined ? [] : [input]);
    }
    owner = parent;
  }
  throw new TypeError(`sender constraint ports.${portName}.${methodName} is required`);
}

async function invokeNativePromise(method: (input?: unknown) => unknown, input: unknown): Promise<unknown> {
  const pending = method(input);
  if (!nodeTypes.isPromise(pending)) throw new TypeError('Security ports must return a native Promise');
  rejectProxy(pending, 'security port Promise');
  if (Object.getOwnPropertyDescriptor(pending, 'constructor') !== undefined) {
    throw new TypeError('Security ports must return an unmodified base Promise');
  }
  const promisePrototype = Object.getPrototypeOf(pending) as object | null;
  if (promisePrototype === null || nodeTypes.isProxy(promisePrototype)) {
    throw new TypeError('Security ports must return an unmodified base Promise');
  }
  const objectPrototype = Object.getPrototypeOf(promisePrototype) as object | null;
  if (objectPrototype === null || Object.getPrototypeOf(objectPrototype) !== null) {
    throw new TypeError('Security port Promise subclasses are not accepted');
  }
  const thenDescriptor = Object.getOwnPropertyDescriptor(promisePrototype, 'then');
  const constructorDescriptor = Object.getOwnPropertyDescriptor(promisePrototype, 'constructor');
  if (
    thenDescriptor === undefined ||
    !('value' in thenDescriptor) ||
    typeof thenDescriptor.value !== 'function' ||
    constructorDescriptor === undefined ||
    !('value' in constructorDescriptor) ||
    typeof constructorDescriptor.value !== 'function' ||
    nodeTypes.isProxy(thenDescriptor.value) ||
    nodeTypes.isProxy(constructorDescriptor.value) ||
    !Function.prototype.toString.call(thenDescriptor.value).includes('[native code]') ||
    !Function.prototype.toString.call(constructorDescriptor.value).includes('[native code]')
  ) {
    throw new TypeError('Security ports must return an unmodified base Promise');
  }
  const settled = new Promise<unknown>((resolve, reject) => {
    Reflect.apply(thenDescriptor.value, pending, [resolve, reject]);
  });
  return settled;
}

function snapshotVerification(value: unknown): DpopProofVerification {
  const valid = requiredField(value, 'valid', 'DPoP verification result');
  if (typeof valid !== 'boolean') throw new TypeError('DPoP verification valid flag must be boolean');
  if (!valid) return Object.freeze({ valid: false });
  return Object.freeze({
    valid: true,
    method: canonicalMethod(requiredField(value, 'method', 'DPoP verification result')),
    targetUri: canonicalTargetUri(requiredField(value, 'targetUri', 'DPoP verification result')),
    accessTokenHash: thumbprint(
      requiredField(value, 'accessTokenHash', 'DPoP verification result'),
      'DPoP ath',
    ),
    jwkThumbprint: thumbprint(
      requiredField(value, 'jwkThumbprint', 'DPoP verification result'),
      'DPoP proof-key thumbprint',
    ),
    jti: boundedString(requiredField(value, 'jti', 'DPoP verification result'), 'DPoP jti', MAX_JTI_LENGTH),
    issuedAt: safeUnixTime(requiredField(value, 'issuedAt', 'DPoP verification result'), 'DPoP iat'),
  });
}

async function enforceDpop(
  ports: SenderConstraintPorts,
  snapshot: DpopSnapshot,
): Promise<SenderConstraintDecision> {
  let verify: (input?: unknown) => unknown;
  let consume: (input?: unknown) => unknown;
  let clockNow: (input?: unknown) => unknown;
  try {
    // Every receiver and method is captured before the first asynchronous boundary.
    verify = snapshotPortMethod(ports, 'dpopProof', 'verify');
    consume = snapshotPortMethod(ports, 'dpopReplay', 'consume');
    clockNow = snapshotPortMethod(ports, 'clock', 'now');
  } catch {
    return denied('port_failure');
  }

  const expectedAccessTokenHash = accessTokenHash(snapshot.token.value);
  const check = Object.freeze({
    proof: snapshot.proof,
    method: snapshot.method,
    targetUri: snapshot.targetUri,
    accessTokenHash: expectedAccessTokenHash,
  });
  let rawVerification: unknown;
  try {
    rawVerification = await invokeNativePromise(verify, check);
  } catch {
    return denied('port_failure');
  }

  let verification: DpopProofVerification;
  try {
    verification = snapshotVerification(rawVerification);
  } catch {
    return denied('port_failure');
  }
  if (!verification.valid) return denied('proof_invalid');
  const tokenJkt = snapshot.token.jkt.value as string;
  if (
    verification.method !== snapshot.method ||
    verification.targetUri !== snapshot.targetUri ||
    !secretEqual(verification.accessTokenHash, expectedAccessTokenHash) ||
    !secretEqual(verification.jwkThumbprint, tokenJkt)
  ) {
    return denied('binding_mismatch');
  }

  let observedAt: number;
  try {
    // Take freshness time after potentially slow signature verification. The atomic
    // replay port remains authoritative for rechecking this window while consuming.
    observedAt = safeUnixTime(clockNow(), 'sender constraint clock');
  } catch {
    return denied('port_failure');
  }
  if (
    verification.issuedAt > observedAt ||
    observedAt - verification.issuedAt > DPOP_PROOF_MAX_AGE_SECONDS
  ) {
    return denied('replay_or_stale');
  }

  const replayCheck = Object.freeze({
    jti: verification.jti,
    jwkThumbprint: verification.jwkThumbprint,
    issuedAt: verification.issuedAt,
    observedAt,
    maxAgeSeconds: DPOP_PROOF_MAX_AGE_SECONDS,
  });
  let consumed: unknown;
  try {
    consumed = await invokeNativePromise(consume, replayCheck);
  } catch {
    return denied('port_failure');
  }
  if (typeof consumed !== 'boolean') return denied('port_failure');
  return consumed ? enforcedDecisions.dpop : denied('replay_or_stale');
}

function enforceMtls(snapshot: MtlsSnapshot): SenderConstraintDecision {
  if (snapshot.source !== 'tls-session' || !snapshot.authenticated) {
    return denied('tls_evidence_invalid');
  }
  const boundThumbprint = snapshot.token.certificateThumbprint.value as string;
  if (!secretEqual(snapshot.presentedCertificateThumbprintSha256, boundThumbprint)) {
    return denied('certificate_mismatch');
  }
  return enforcedDecisions.mtls;
}

/**
 * Enforce sender-constrained access tokens for remote high-risk management.
 * Routing, JWT verification, TLS extraction, and replay-store implementation remain adapter duties.
 */
export async function enforceSenderConstraint(
  ports: SenderConstraintPorts,
  input: SenderConstraintInput,
): Promise<SenderConstraintDecision> {
  let classification: ClassificationSnapshot;
  try {
    classification = snapshotClassification(input);
  } catch {
    return denied('invalid_input');
  }

  const expectedApplicable =
    classification.location === 'remote' && highRiskOperations.has(classification.operation);
  if (
    classification.applicability !== (expectedApplicable ? 'applicable' : 'not_applicable')
  ) {
    return denied('applicability_mismatch');
  }
  if (!expectedApplicable) {
    if (
      classification.mode !== 'not_applicable' ||
      classification.accessToken.found ||
      classification.dpop.found ||
      classification.mtls.found
    ) {
      return denied('mode_conflict');
    }
    return notApplicableDecision;
  }
  if (classification.mode === 'not_applicable') return denied('sender_constraint_required');
  if (
    (classification.mode === 'dpop' && classification.mtls.found) ||
    (classification.mode === 'mtls' && classification.dpop.found)
  ) {
    return denied('mode_conflict');
  }

  if (classification.mode === 'dpop') {
    let snapshot: DpopSnapshot;
    try {
      snapshot = snapshotDpop(classification);
    } catch (error) {
      return denied(error instanceof ModeConflictError ? 'mode_conflict' : 'invalid_input');
    }
    return enforceDpop(ports, snapshot);
  }

  let snapshot: MtlsSnapshot;
  try {
    snapshot = snapshotMtls(classification);
  } catch (error) {
    return denied(error instanceof ModeConflictError ? 'mode_conflict' : 'invalid_input');
  }
  return enforceMtls(snapshot);
}
