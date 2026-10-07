import { cloneAndFreezeJsonData } from '../schema/json.js';
import { snapshotBoundedStrings } from './bounded-string-array.js';

/** RFC 8414 / RFC 9207 discovery and exact issuer identity (SEC-0019). */
import {
  assertPlainRecord,
  exactOwnStringKeys,
  readOwnDataProperty,
  requireOwnDataProperty,
} from './input-snapshot.js';

// =====================================================================
// Exact OAuth issuer identity and discovery
// =====================================================================

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
  );
}

function assertIssuerUrl(issuer: string, label: string): URL {
  // URL parsing is for syntax only. Never use its normalized serialization as identity.
  if (!/^https?:\/\//iu.test(issuer)
    || /[\u0000-\u0020\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\\]/u.test(issuer)) {
    throw new TypeError(`${label} must be an absolute http(s) URL without whitespace or backslashes`);
  }
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new TypeError(`${label} must be an absolute http(s) URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`${label} must use the http(s) scheme`);
  }
  if (issuer.includes('?') || issuer.includes('#')) {
    throw new TypeError(`${label} must not carry a query or fragment`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError(`${label} must not contain userinfo`);
  }
  return url;
}

/**
 * Validate an RFC 8414 issuer and preserve its exact comparison/storage key.
 * The historical name is retained for API compatibility, not URL normalization.
 * Case, default ports, trailing slashes and percent encodings remain distinct.
 * Existing alias-normalized credential stores must rebind from trusted issuer
 * metadata or re-register; never try an alias fallback when selecting secrets.
 */
export function canonicalOAuthIssuer(issuer: string): string {
  if (typeof issuer !== 'string' || issuer.length === 0) {
    throw new TypeError('issuer must be a non-empty string');
  }
  assertIssuerUrl(issuer, 'issuer');
  return issuer;
}

// =====================================================================
// RFC 9207 authorization response iss
// =====================================================================

/** Input for the RFC 9207 authorization-response `iss` check. */
export interface OAuthAuthorizationResponseIssInput {
  /** Issuer recorded when the authorization request was issued. */
  readonly expectedIssuer: string;
  /** Form-urldecoded `iss` query parameter from the callback, if present. */
  readonly iss: string | undefined;
  /** Whether the AS metadata advertised `authorization_response_iss_parameter_supported`. */
  readonly issParameterSupported: boolean;
}

export type OAuthAuthorizationResponseIssDenialReason =
  | 'invalid_input'
  | 'issuer_missing'
  | 'issuer_swap';

export type OAuthAuthorizationResponseIssDecision =
  | {
      readonly allowed: true;
      readonly reason: 'issuer_matches';
      readonly matchedIssuer: string;
    }
  | {
      readonly allowed: false;
      readonly reason: OAuthAuthorizationResponseIssDenialReason;
    };

const ISS_INPUT_KEYS = Object.freeze(['expectedIssuer', 'iss', 'issParameterSupported']);

function snapshotIssInput(input: unknown): OAuthAuthorizationResponseIssInput {
  assertPlainRecord(input, 'iss input');
  exactOwnStringKeys(input, ISS_INPUT_KEYS, 'iss input');
  const expectedIssuer = requireOwnDataProperty(input, 'expectedIssuer', 'iss expectedIssuer');
  const iss = readOwnDataProperty(input, 'iss');
  const issParameterSupported = requireOwnDataProperty(input, 'issParameterSupported', 'iss issParameterSupported');
  if (typeof expectedIssuer !== 'string' || expectedIssuer.length === 0) {
    throw new TypeError('iss expectedIssuer must be a non-empty string');
  }
  const issValue = iss.found && iss.value !== undefined ? iss.value : undefined;
  if (issValue !== undefined && typeof issValue !== 'string') {
    throw new TypeError('iss value must be a string when present');
  }
  if (issParameterSupported !== true && issParameterSupported !== false) {
    throw new TypeError('iss issParameterSupported must be a boolean');
  }
  return Object.freeze({
    expectedIssuer,
    iss: issValue,
    issParameterSupported,
  });
}

/**
 * Enforce RFC 9207 §2.4: when `iss` is present it must exactly match the
 * recorded issuer byte-for-byte, and when the AS
 * metadata requires `iss` it must be present. Missing-required and swapped
 * values are denied; the caller never proceeds to code exchange with client
 * credentials.
 */
export function enforceOAuthAuthorizationResponseIss(
  input: unknown,
): OAuthAuthorizationResponseIssDecision {
  let snapshot: OAuthAuthorizationResponseIssInput;
  try {
    snapshot = snapshotIssInput(input);
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  let expectedCanonical: string;
  try {
    expectedCanonical = canonicalOAuthIssuer(snapshot.expectedIssuer);
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  if (snapshot.iss === undefined) {
    if (snapshot.issParameterSupported) {
      return Object.freeze({ allowed: false, reason: 'issuer_missing' } as const);
    }
    return Object.freeze({
      allowed: true,
      reason: 'issuer_matches',
      matchedIssuer: expectedCanonical,
    } as const);
  }
  let presentedCanonical: string;
  try {
    presentedCanonical = canonicalOAuthIssuer(snapshot.iss);
  } catch {
    return Object.freeze({ allowed: false, reason: 'issuer_swap' } as const);
  }
  if (presentedCanonical !== expectedCanonical) {
    return Object.freeze({ allowed: false, reason: 'issuer_swap' } as const);
  }
  return Object.freeze({
    allowed: true,
    reason: 'issuer_matches',
    matchedIssuer: presentedCanonical,
  } as const);
}

// =====================================================================
// Authorization-server mix-up defense at token exchange
// =====================================================================

/** Input for the token-exchange issuer binding check. */
export interface OAuthTokenExchangeIssuerInput {
  /** Issuer recorded when the authorization request was issued. */
  readonly recordedIssuer: string;
  /** Issuer resolved for the token exchange on this call. */
  readonly exchangeIssuer: string;
}

export type OAuthTokenExchangeIssuerDenialReason = 'invalid_input' | 'issuer_mixup';

export type OAuthTokenExchangeIssuerDecision =
  | { readonly allowed: true; readonly reason: 'issuer_bound'; readonly issuer: string }
  | { readonly allowed: false; readonly reason: OAuthTokenExchangeIssuerDenialReason };

const TOKEN_EXCHANGE_ISSUER_KEYS = Object.freeze(['recordedIssuer', 'exchangeIssuer']);

/**
 * Enforce the authorization-server mix-up defense at code exchange: the
 * authorization code and PKCE verifier are bound to the AS that minted them,
 * so the token-exchange issuer must equal the issuer recorded at
 * authorization-request time. Sending the code to a different AS is a
 * credential-exfiltration vector and is denied.
 */
export function enforceOAuthTokenExchangeIssuer(
  input: unknown,
): OAuthTokenExchangeIssuerDecision {
  assertPlainRecord(input, 'token exchange issuer input');
  exactOwnStringKeys(input, TOKEN_EXCHANGE_ISSUER_KEYS, 'token exchange issuer input');
  const recordedIssuer = requireOwnDataProperty(input, 'recordedIssuer', 'recordedIssuer');
  const exchangeIssuer = requireOwnDataProperty(input, 'exchangeIssuer', 'exchangeIssuer');
  if (typeof recordedIssuer !== 'string' || typeof exchangeIssuer !== 'string') {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  let recordedCanonical: string;
  let exchangeCanonical: string;
  try {
    recordedCanonical = canonicalOAuthIssuer(recordedIssuer);
    exchangeCanonical = canonicalOAuthIssuer(exchangeIssuer);
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  if (recordedCanonical !== exchangeCanonical) {
    return Object.freeze({ allowed: false, reason: 'issuer_mixup' } as const);
  }
  return Object.freeze({
    allowed: true,
    reason: 'issuer_bound',
    issuer: recordedCanonical,
  } as const);
}

// =====================================================================
// RFC 8414 authorization-server metadata
// =====================================================================

/** Validated authorization-server metadata; issuer spelling is preserved. */
export interface OAuthAuthorizationServerMetadataSnapshot {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly codeChallengeMethodsSupported?: readonly string[];
  readonly authorizationResponseIssParameterSupported: boolean;
  readonly grantTypesSupported?: readonly string[];
}

export type OAuthAuthorizationServerMetadataDenialReason =
  | 'invalid_input'
  | 'invalid_issuer'
  | 'insecure_issuer'
  | 'issuer_has_query_or_fragment'
  | 'expected_issuer_required'
  | 'issuer_mismatch'
  | 'missing_authorization_endpoint'
  | 'invalid_authorization_endpoint'
  | 'insecure_authorization_endpoint'
  | 'missing_token_endpoint'
  | 'invalid_token_endpoint'
  | 'insecure_token_endpoint'
  | 'missing_registration_endpoint'
  | 'invalid_registration_endpoint'
  | 'response_types_invalid'
  | 'code_challenge_methods_invalid'
  | 'pkce_s256_not_supported';

export type OAuthAuthorizationServerMetadataDecision =
  | {
      readonly allowed: true;
      readonly reason: 'metadata_valid';
      readonly metadata: OAuthAuthorizationServerMetadataSnapshot;
    }
  | { readonly allowed: false; readonly reason: OAuthAuthorizationServerMetadataDenialReason };

export interface OAuthAuthorizationServerMetadataOptions {
  /** Require `registration_endpoint` (dynamic client registration needed). */
  readonly requireDcr?: boolean;
  /**
   * Trusted issuer used to start discovery, never copied from the response.
   * Required for success at runtime. Kept optional in the type so old callers
   * fail closed with a typed denial instead of failing to compile.
   */
  readonly expectedIssuer?: string;
}

// RFC 8414 metadata is extensible. Bound and inspect the own-data surface,
// but do not reject valid standard/extension fields merely because we ignore them.
const MAX_METADATA_MEMBERS = 256;

interface MetadataSnapshot {
  readonly issuer: unknown;
  readonly authorizationEndpoint: unknown;
  readonly tokenEndpoint: unknown;
  readonly registrationEndpoint: unknown;
  readonly codeChallengeMethodsSupported: unknown;
  readonly authorizationResponseIssParameterSupported: unknown;
  readonly grantTypesSupported: unknown;
  readonly responseTypesSupported: unknown;
}

function snapshotMetadata(input: unknown): MetadataSnapshot {
  // Older callers commonly spell an absent optional metadata member as
  // `undefined`. Treat that representation as absent before the strict JSON
  // clone, while still rejecting accessors, symbols, proxies, and custom
  // prototypes without reading untrusted getters.
  assertPlainRecord(input, 'authorization server metadata');
  const inputKeys = Reflect.ownKeys(input);
  if (inputKeys.length > MAX_METADATA_MEMBERS) throw new TypeError('authorization server metadata is too large');
  const jsonInput: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of inputKeys) {
    if (typeof key !== 'string') throw new TypeError('authorization server metadata has an invalid member');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('authorization server metadata must contain own enumerable data properties');
    }
    if (descriptor.value !== undefined) jsonInput[key] = descriptor.value;
  }
  const cloned = cloneAndFreezeJsonData(jsonInput, { maxDepth: 16, maxMembers: 2048, maxBytes: 64 * 1024 });
  const keys = Reflect.ownKeys(cloned);
  if (keys.length > MAX_METADATA_MEMBERS) throw new TypeError('authorization server metadata is too large');
  for (const key of keys) {
    if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new TypeError('authorization server metadata has an invalid member');
    }
    const descriptor = Object.getOwnPropertyDescriptor(cloned, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('authorization server metadata must contain own enumerable data properties');
    }
  }
  const issuer = readOwnDataProperty(cloned, 'issuer');
  const authorizationEndpoint = readOwnDataProperty(cloned, 'authorization_endpoint');
  const tokenEndpoint = readOwnDataProperty(cloned, 'token_endpoint');
  const registrationEndpoint = readOwnDataProperty(cloned, 'registration_endpoint');
  const codeChallengeMethods = readOwnDataProperty(cloned, 'code_challenge_methods_supported');
  const issParameterSupported = readOwnDataProperty(cloned, 'authorization_response_iss_parameter_supported');
  const grantTypes = readOwnDataProperty(cloned, 'grant_types_supported');
  const responseTypes = readOwnDataProperty(cloned, 'response_types_supported');
  return Object.freeze({
    issuer: issuer.found && issuer.value !== undefined ? issuer.value : undefined,
    authorizationEndpoint:
      authorizationEndpoint.found && authorizationEndpoint.value !== undefined
        ? authorizationEndpoint.value
        : undefined,
    tokenEndpoint: tokenEndpoint.found && tokenEndpoint.value !== undefined ? tokenEndpoint.value : undefined,
    registrationEndpoint:
      registrationEndpoint.found && registrationEndpoint.value !== undefined
        ? registrationEndpoint.value
        : undefined,
    codeChallengeMethodsSupported:
      codeChallengeMethods.found && codeChallengeMethods.value !== undefined
        ? codeChallengeMethods.value
        : undefined,
    authorizationResponseIssParameterSupported:
      issParameterSupported.found && issParameterSupported.value !== undefined
        ? issParameterSupported.value
        : false,
    grantTypesSupported: grantTypes.found && grantTypes.value !== undefined ? grantTypes.value : undefined,
    responseTypesSupported: responseTypes.found ? responseTypes.value : undefined,
  });
}

function endpointReason(value: unknown, loopbackHttpOrigin?: string): 'missing' | 'invalid' | 'insecure' | 'ok' {
  if (typeof value !== 'string' || value.length === 0) return 'missing';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'invalid';
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') return 'invalid';
  if (url.protocol === 'https:') return 'ok';
  if (url.protocol === 'http:' && loopbackHttpOrigin !== undefined
    && isLoopbackHost(url.hostname) && url.origin === loopbackHttpOrigin) return 'ok';
  return 'insecure';
}

function issuerMetadataReason(issuer: unknown): OAuthAuthorizationServerMetadataDenialReason | 'ok' {
  if (typeof issuer !== 'string' || issuer.length === 0) return 'invalid_issuer';
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return 'invalid_issuer';
  }
  if (issuer.includes('?') || issuer.includes('#')) return 'issuer_has_query_or_fragment';
  try {
    assertIssuerUrl(issuer, 'issuer');
  } catch {
    return 'invalid_issuer';
  }
  if (url.protocol === 'https:') return 'ok';
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return 'ok';
  return 'insecure_issuer';
}

function snapshotOptionalStringArray(value: unknown, name: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const entries = snapshotBoundedStrings(value, name, { maxEntries: 256, maxStringBytes: 4096, maxTotalBytes: 64 * 1024, allowEmpty: true });
  if (!entries.every((entry) => typeof entry === 'string')) {
    throw new TypeError(`${name} entries must be strings`);
  }
  return entries as readonly string[];
}

/**
 * Validate RFC 8414 metadata and bind its issuer to trusted discovery input.
 * No endpoint is returned without an exact issuer match. Endpoint hosts need
 * not equal the issuer host: authorized deployments may separate them.
 */
export function enforceOAuthAuthorizationServerMetadata(
  metadata: unknown,
  options: OAuthAuthorizationServerMetadataOptions = {},
): OAuthAuthorizationServerMetadataDecision {
  let snapshot: MetadataSnapshot;
  let expectedIssuer: unknown;
  let requireDcr: boolean;
  try {
    snapshot = snapshotMetadata(metadata);
    assertPlainRecord(options, 'authorization server metadata options');
    expectedIssuer = readOwnDataProperty(options, 'expectedIssuer').value;
    const dcr = readOwnDataProperty(options, 'requireDcr').value;
    if (dcr !== undefined && typeof dcr !== 'boolean') throw new TypeError('requireDcr must be boolean');
    requireDcr = dcr === true;
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }

  const issuerReason = issuerMetadataReason(snapshot.issuer);
  if (issuerReason !== 'ok') {
    return Object.freeze({ allowed: false, reason: issuerReason } as const);
  }
  if (expectedIssuer !== undefined) {
    if (issuerMetadataReason(expectedIssuer) !== 'ok') {
      return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
    }
    if (expectedIssuer !== snapshot.issuer) {
      return Object.freeze({ allowed: false, reason: 'issuer_mismatch' } as const);
    }
  }
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(snapshot.issuer as string);
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_issuer' } as const);
  }
  // Plain HTTP endpoints are permitted only for a genuinely loopback issuer.
  // A remote issuer must not be able to redirect browser or token traffic to
  // a local service through otherwise valid metadata.
  const loopbackHttpOrigin = issuerUrl.protocol === 'http:' && isLoopbackHost(issuerUrl.hostname)
    ? issuerUrl.origin
    : undefined;
  const authorizationEndpointReason = endpointReason(snapshot.authorizationEndpoint, loopbackHttpOrigin);
  if (authorizationEndpointReason === 'missing') {
    return Object.freeze({ allowed: false, reason: 'missing_authorization_endpoint' } as const);
  }
  if (authorizationEndpointReason === 'invalid') {
    return Object.freeze({ allowed: false, reason: 'invalid_authorization_endpoint' } as const);
  }
  if (authorizationEndpointReason === 'insecure') {
    return Object.freeze({ allowed: false, reason: 'insecure_authorization_endpoint' } as const);
  }
  const tokenEndpointReason = endpointReason(snapshot.tokenEndpoint, loopbackHttpOrigin);
  if (tokenEndpointReason === 'missing') {
    return Object.freeze({ allowed: false, reason: 'missing_token_endpoint' } as const);
  }
  if (tokenEndpointReason === 'invalid') {
    return Object.freeze({ allowed: false, reason: 'invalid_token_endpoint' } as const);
  }
  if (tokenEndpointReason === 'insecure') {
    return Object.freeze({ allowed: false, reason: 'insecure_token_endpoint' } as const);
  }

  if (snapshot.registrationEndpoint === undefined) {
    if (requireDcr) {
      return Object.freeze({ allowed: false, reason: 'missing_registration_endpoint' } as const);
    }
  } else if (endpointReason(snapshot.registrationEndpoint, loopbackHttpOrigin) !== 'ok') {
    return Object.freeze({ allowed: false, reason: 'invalid_registration_endpoint' } as const);
  }

  let codeChallengeMethodsSupported: readonly string[] | undefined;
  try {
    codeChallengeMethodsSupported = snapshotOptionalStringArray(
      snapshot.codeChallengeMethodsSupported,
      'code_challenge_methods_supported',
    );
  } catch {
    return Object.freeze({ allowed: false, reason: 'code_challenge_methods_invalid' } as const);
  }
  if (
    codeChallengeMethodsSupported === undefined
    || !codeChallengeMethodsSupported.includes('S256')
  ) {
    return Object.freeze({ allowed: false, reason: 'pkce_s256_not_supported' } as const);
  }

  // response_types_supported is required by RFC 8414. This client uses code flow.
  let responseTypesSupported: readonly string[] | undefined;
  try {
    responseTypesSupported = snapshotOptionalStringArray(snapshot.responseTypesSupported, 'response_types_supported');
  } catch {
    return Object.freeze({ allowed: false, reason: 'response_types_invalid' } as const);
  }
  if (responseTypesSupported === undefined || !responseTypesSupported.includes('code')
    || responseTypesSupported.some((value) => value.length === 0)) {
    return Object.freeze({ allowed: false, reason: 'response_types_invalid' } as const);
  }

  const issSupported = snapshot.authorizationResponseIssParameterSupported;
  if (issSupported !== true && issSupported !== false) {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }

  let grantTypesSupported: readonly string[] | undefined;
  try {
    grantTypesSupported = snapshotOptionalStringArray(snapshot.grantTypesSupported, 'grant_types_supported');
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  // Preserve earlier malformed-document diagnostics, but never let an old
  // unpinned caller receive trusted authorization/token endpoints.
  if (expectedIssuer === undefined) {
    return Object.freeze({ allowed: false, reason: 'expected_issuer_required' } as const);
  }

  const metadataSnapshot: OAuthAuthorizationServerMetadataSnapshot = Object.freeze({
    issuer: canonicalOAuthIssuer(snapshot.issuer as string),
    authorizationEndpoint: snapshot.authorizationEndpoint as string,
    tokenEndpoint: snapshot.tokenEndpoint as string,
    ...(snapshot.registrationEndpoint !== undefined
      ? { registrationEndpoint: snapshot.registrationEndpoint as string }
      : {}),
    ...(codeChallengeMethodsSupported !== undefined
      ? { codeChallengeMethodsSupported }
      : {}),
    authorizationResponseIssParameterSupported: issSupported,
    ...(grantTypesSupported !== undefined
      ? { grantTypesSupported }
      : {}),
  });

  return Object.freeze({
    allowed: true,
    reason: 'metadata_valid',
    metadata: metadataSnapshot,
  } as const);
}
