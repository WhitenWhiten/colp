import { createHash, timingSafeEqual } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import { credentialQueryDenial } from './credential-query-value.js';
import { inspectExactDenseArray } from './dense-array.js';
import { assertUnixSeconds } from './time-units.js';

export const OAUTH_ACCESS_TOKEN_TTL_CEILING_SECONDS = 3_600 as const;

export type OAuth21Integration =
  | 'remote-mcp'
  | 'third-party'
  | 'local-mcp'
  | 'first-party'
  | 'other';

export type OAuth21ProfileApplicability = 'applicable' | 'not-applicable';
export type OAuthAuthorizationServerDiscoveryMethod =
  | 'authorization-server-metadata'
  | 'openid-connect-discovery';

export interface OAuthProtectedResourceMetadata {
  readonly resource: string;
  readonly authorizationServers: readonly string[];
}

export interface OAuthAuthorizationServerDiscovery {
  readonly authorizationServer: string;
  readonly method: OAuthAuthorizationServerDiscoveryMethod;
  readonly discoveryUrl: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

export interface OAuthResourceIndicatorRequest {
  readonly resource: string | readonly string[];
}

export interface OAuthAccessTokenEvidence {
  readonly audience: string | readonly string[];
  /**
   * Token `iat` NumericDate.
   * Unit: {@link import('./time-units.js').NumericDateSeconds} (Unix whole seconds).
   */
  readonly issuedAt: number;
  /**
   * Token `exp` NumericDate.
   * Unit: {@link import('./time-units.js').NumericDateSeconds} (Unix whole seconds).
   */
  readonly expiresAt: number;
}

export interface OAuthBearerTransportEvidence {
  /** The raw HTTP request target before routing or query coercion. */
  readonly requestTarget: string;
  /** One value, or every raw Authorization field value when exposed separately. */
  readonly authorization: string | readonly string[];
}

export interface OAuthPkceEvidence {
  readonly challengeMethod: string;
  readonly challenge: string;
  readonly verifier: string;
}

export interface OAuthClientEvidence {
  readonly type: 'public' | 'confidential';
  readonly pkce?: OAuthPkceEvidence;
}

export interface OAuthRefreshTokenEvidence {
  readonly issued: boolean;
  readonly rotation: 'rotate-on-use' | 'none';
  readonly previousToken?: string;
  readonly currentToken?: string;
}

export interface OAuthUpstreamTokenEvidence {
  readonly value: string;
  readonly source: 'authorization-header';
}

export interface OAuthOutboundTokenEvidence {
  readonly value: string;
  readonly source: 'server-issued' | 'token-exchange' | 'upstream';
}

export interface OAuthTokenFlowEvidence {
  readonly upstream: OAuthUpstreamTokenEvidence;
  readonly outbound?: OAuthOutboundTokenEvidence;
}

export interface OAuth21ProfileInput {
  readonly integration: OAuth21Integration;
  readonly applicability: OAuth21ProfileApplicability;
  readonly protectedResourceMetadata: OAuthProtectedResourceMetadata;
  readonly authorizationServerDiscovery: OAuthAuthorizationServerDiscovery;
  readonly authorizationRequest: OAuthResourceIndicatorRequest;
  readonly tokenRequest: OAuthResourceIndicatorRequest;
  readonly accessToken: OAuthAccessTokenEvidence;
  readonly transport: OAuthBearerTransportEvidence;
  readonly client: OAuthClientEvidence;
  readonly refreshToken: OAuthRefreshTokenEvidence;
  readonly tokenFlow: OAuthTokenFlowEvidence;
}

export interface OAuthAuthorizationServerProvenanceCheck {
  readonly resource: string;
  readonly authorizationServer: string;
  readonly method: OAuthAuthorizationServerDiscoveryMethod;
  readonly discoveryUrl: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

export interface OAuthAuthorizationServerProvenancePort {
  isAuthorized(input: OAuthAuthorizationServerProvenanceCheck): Promise<boolean>;
}

export interface OAuth21ProfilePorts {
  readonly authorizationServerProvenance: OAuthAuthorizationServerProvenancePort;
}

export type OAuth21ProfileDenialReason =
  | 'invalid_input'
  | 'applicability_mismatch'
  | 'invalid_protected_resource_metadata'
  | 'invalid_authorization_server_discovery'
  | 'authorization_resource_mismatch'
  | 'token_resource_mismatch'
  | 'audience_mismatch'
  | 'credential_in_query'
  | 'invalid_authorization'
  | 'pkce_s256_required'
  | 'access_token_lifetime_invalid'
  | 'access_token_ttl_exceeded'
  | 'refresh_token_rotation_required'
  | 'token_passthrough_forbidden'
  | 'discovery_not_authorized'
  | 'port_failure';

export type OAuth21ProfileDecision =
  | {
      readonly allowed: true;
      readonly disposition: 'enforced';
      readonly integration: 'remote-mcp' | 'third-party';
      readonly reason: 'profile_satisfied';
    }
  | {
      readonly allowed: true;
      readonly disposition: 'not_applicable';
      readonly integration: 'local-mcp' | 'first-party' | 'other';
      readonly reason: 'not_applicable';
    }
  | {
      readonly allowed: false;
      readonly disposition: 'denied';
      readonly integration: 'remote-mcp' | 'third-party' | 'unknown';
      readonly reason: OAuth21ProfileDenialReason;
    };

type ApplicableIntegration = 'remote-mcp' | 'third-party';
type NotApplicableIntegration = 'local-mcp' | 'first-party' | 'other';

interface ApplicabilitySnapshot {
  readonly integration: OAuth21Integration;
  readonly applicability: OAuth21ProfileApplicability;
}

interface DiscoverySnapshot {
  readonly authorizationServer: string;
  readonly method: OAuthAuthorizationServerDiscoveryMethod;
  readonly discoveryUrl: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

interface ApplicableInputSnapshot {
  readonly integration: ApplicableIntegration;
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly discovery: DiscoverySnapshot;
  readonly authorizationResources: readonly string[];
  readonly tokenResources: readonly string[];
  readonly audiences: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly requestTarget: string;
  readonly authorizationValues: readonly string[];
  readonly clientType: 'public' | 'confidential';
  readonly pkce: OAuthPkceEvidence | undefined;
  readonly refreshToken: OAuthRefreshTokenEvidence;
  readonly upstreamToken: OAuthUpstreamTokenEvidence;
  readonly outboundToken: OAuthOutboundTokenEvidence | undefined;
}

interface CanonicalProfileSnapshot extends ApplicableInputSnapshot {
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly discovery: DiscoverySnapshot;
  readonly authorizationResources: readonly string[];
  readonly tokenResources: readonly string[];
  readonly audiences: readonly string[];
}

const MAX_URL_LENGTH = 4_096;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_URI_VALUES = 16;
const MAX_QUERY_ENTRIES = 256;
const controlCharacters = /[\u0000-\u001f\u007f]/u;
const loneSurrogate = /[\uD800-\uDFFF]/u;
const whitespace = /\s/u;
const ambiguousDotSegment = /(?:^|\/)(?:(?:%2e)|\.){1,2}(?=\/|[?#]|$)/iu;
const encodedPathSeparator = /%(?:2f|5c)/iu;
const percentEscape = /%([0-9a-f]{2})/giu;
const token68 = /^[A-Za-z0-9\-._~+/]+={0,}$/u;
const pkceVerifier = /^[A-Za-z0-9._~-]{43,128}$/u;
const pkceChallenge = /^[A-Za-z0-9_-]{43}$/u;
const applicableIntegrations = new Set<OAuth21Integration>(['remote-mcp', 'third-party']);
const notApplicableIntegrations = new Set<OAuth21Integration>([
  'local-mcp',
  'first-party',
  'other',
]);

const enforcedDecisions = Object.freeze({
  'remote-mcp': Object.freeze({
    allowed: true,
    disposition: 'enforced',
    integration: 'remote-mcp',
    reason: 'profile_satisfied',
  } as const),
  'third-party': Object.freeze({
    allowed: true,
    disposition: 'enforced',
    integration: 'third-party',
    reason: 'profile_satisfied',
  } as const),
});

const notApplicableDecisions = Object.freeze({
  'local-mcp': Object.freeze({
    allowed: true,
    disposition: 'not_applicable',
    integration: 'local-mcp',
    reason: 'not_applicable',
  } as const),
  'first-party': Object.freeze({
    allowed: true,
    disposition: 'not_applicable',
    integration: 'first-party',
    reason: 'not_applicable',
  } as const),
  other: Object.freeze({
    allowed: true,
    disposition: 'not_applicable',
    integration: 'other',
    reason: 'not_applicable',
  } as const),
});

const unknownDenials = createDenialDecisions('unknown');
const applicableDenials = Object.freeze({
  'remote-mcp': createDenialDecisions('remote-mcp'),
  'third-party': createDenialDecisions('third-party'),
});

function createDenialDecisions(integration: ApplicableIntegration | 'unknown'):
Readonly<Record<OAuth21ProfileDenialReason, OAuth21ProfileDecision>> {
  const reasons: readonly OAuth21ProfileDenialReason[] = Object.freeze([
    'invalid_input',
    'applicability_mismatch',
    'invalid_protected_resource_metadata',
    'invalid_authorization_server_discovery',
    'authorization_resource_mismatch',
    'token_resource_mismatch',
    'audience_mismatch',
    'credential_in_query',
    'invalid_authorization',
    'pkce_s256_required',
    'access_token_lifetime_invalid',
    'access_token_ttl_exceeded',
    'refresh_token_rotation_required',
    'token_passthrough_forbidden',
    'discovery_not_authorized',
    'port_failure',
  ]);
  return Object.freeze(
    Object.fromEntries(
      reasons.map((reason) => [
        reason,
        Object.freeze({ allowed: false, disposition: 'denied', integration, reason } as const),
      ]),
    ) as Record<OAuth21ProfileDenialReason, OAuth21ProfileDecision>,
  );
}

function denied(
  integration: ApplicableIntegration | 'unknown',
  reason: OAuth21ProfileDenialReason,
): OAuth21ProfileDecision {
  return integration === 'unknown'
    ? unknownDenials[reason]
    : applicableDenials[integration][reason];
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectProxy(value: unknown, name: string): void {
  if (nodeTypes.isProxy(value)) throw new TypeError(`${name} must not be a Proxy`);
}

function ownData(value: unknown, key: PropertyKey, name: string): unknown | undefined {
  if (!isRecord(value)) throw new TypeError(`${name} must be supplied in an object`);
  rejectProxy(value, name);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw new TypeError(`${name}.${String(key)} must be an own data property`);
  return descriptor.value;
}

function requiredOwnData(value: unknown, key: PropertyKey, name: string): unknown {
  const result = ownData(value, key, name);
  if (result === undefined) throw new TypeError(`${name}.${String(key)} is required`);
  return result;
}

function denseArraySnapshot(value: unknown, name: string): readonly unknown[] {
  // Historical: Proxy rejected, custom prototypes allowed; extra own keys allowed.
  const result = inspectExactDenseArray(value, {
    maxLength: MAX_URI_VALUES,
    allowExtraOwnKeys: true,
    requireStandardPrototype: false,
  });
  if (!result.ok) {
    switch (result.failure) {
      case 'not-array':
        throw new TypeError(`${name} must be an array`);
      case 'proxy':
        throw new TypeError(`${name} must not be a Proxy`);
      case 'custom-prototype':
        throw new TypeError(`${name} must not be a Proxy`);
      case 'invalid-length':
        throw new TypeError(`${name} has an invalid length`);
      case 'not-dense':
      case 'extra-keys':
        throw new TypeError(`${name} must be dense`);
      case 'non-data-entry':
        throw new TypeError(`${name} entries must be own data properties`);
    }
  }
  return Object.freeze(result.values);
}

function nonEmptyString(value: unknown, name: string, maximumLength = MAX_URL_LENGTH): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    controlCharacters.test(value)
  ) {
    throw new TypeError(`${name} must be a bounded non-empty string without control characters`);
  }
  return value;
}

function boundedString(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new TypeError(`${name} must be a bounded string`);
  }
  return value;
}

function tokenString(value: unknown, name: string): string {
  const token = nonEmptyString(value, name, MAX_TOKEN_LENGTH);
  if (whitespace.test(token)) throw new TypeError(`${name} must not contain whitespace`);
  return token;
}

function snapshotStringArray(value: unknown, name: string): readonly string[] {
  return Object.freeze(
    denseArraySnapshot(value, name).map((entry) => nonEmptyString(entry, `${name} entry`)),
  );
}

function snapshotStringOrArray(value: unknown, name: string): readonly string[] {
  return typeof value === 'string'
    ? Object.freeze([nonEmptyString(value, name)])
    : snapshotStringArray(value, name);
}

function snapshotAuthorization(value: unknown): readonly string[] {
  return typeof value === 'string'
    ? Object.freeze([boundedString(value, 'transport.authorization', MAX_TOKEN_LENGTH + 16)])
    : Object.freeze(
        denseArraySnapshot(value, 'transport.authorization').map((entry) =>
          boundedString(entry, 'transport.authorization entry', MAX_TOKEN_LENGTH + 16),
        ),
      );
}

function snapshotApplicability(input: unknown): ApplicabilitySnapshot {
  const integration = requiredOwnData(input, 'integration', 'OAuth profile input');
  const applicability = requiredOwnData(input, 'applicability', 'OAuth profile input');
  if (
    typeof integration !== 'string' ||
    (!applicableIntegrations.has(integration as OAuth21Integration) &&
      !notApplicableIntegrations.has(integration as OAuth21Integration))
  ) {
    throw new TypeError('OAuth profile input.integration is invalid');
  }
  if (applicability !== 'applicable' && applicability !== 'not-applicable') {
    throw new TypeError('OAuth profile input.applicability is invalid');
  }
  return Object.freeze({
    integration: integration as OAuth21Integration,
    applicability,
  });
}

function snapshotPkce(value: unknown): OAuthPkceEvidence | undefined {
  if (value === undefined) return undefined;
  const challengeMethod = ownData(value, 'challengeMethod', 'client.pkce');
  const challenge = ownData(value, 'challenge', 'client.pkce');
  const verifier = ownData(value, 'verifier', 'client.pkce');
  if (
    typeof challengeMethod !== 'string' ||
    typeof challenge !== 'string' ||
    typeof verifier !== 'string'
  ) {
    return Object.freeze({ challengeMethod: '', challenge: '', verifier: '' });
  }
  return Object.freeze({
    challengeMethod,
    challenge,
    verifier,
  });
}

function snapshotRefreshToken(value: unknown): OAuthRefreshTokenEvidence {
  const issued = requiredOwnData(value, 'issued', 'refreshToken');
  const rotation = requiredOwnData(value, 'rotation', 'refreshToken');
  if (typeof issued !== 'boolean' || (rotation !== 'rotate-on-use' && rotation !== 'none')) {
    throw new TypeError('refreshToken evidence is invalid');
  }
  const previousValue = ownData(value, 'previousToken', 'refreshToken');
  const currentValue = ownData(value, 'currentToken', 'refreshToken');
  return Object.freeze({
    issued,
    rotation,
    ...(previousValue === undefined
      ? {}
      : { previousToken: tokenString(previousValue, 'refreshToken.previousToken') }),
    ...(currentValue === undefined
      ? {}
      : { currentToken: tokenString(currentValue, 'refreshToken.currentToken') }),
  });
}

function snapshotTokenFlow(value: unknown): {
  readonly upstreamToken: OAuthUpstreamTokenEvidence;
  readonly outboundToken: OAuthOutboundTokenEvidence | undefined;
} {
  const upstream = requiredOwnData(value, 'upstream', 'tokenFlow');
  const upstreamSource = requiredOwnData(upstream, 'source', 'tokenFlow.upstream');
  if (upstreamSource !== 'authorization-header') {
    throw new TypeError('tokenFlow.upstream.source is invalid');
  }
  const upstreamToken = Object.freeze({
    value: tokenString(requiredOwnData(upstream, 'value', 'tokenFlow.upstream'), 'tokenFlow.upstream.value'),
    source: 'authorization-header' as const,
  });
  const outbound = ownData(value, 'outbound', 'tokenFlow');
  if (outbound === undefined) return Object.freeze({ upstreamToken, outboundToken: undefined });
  const outboundSource = requiredOwnData(outbound, 'source', 'tokenFlow.outbound');
  if (
    outboundSource !== 'server-issued' &&
    outboundSource !== 'token-exchange' &&
    outboundSource !== 'upstream'
  ) {
    throw new TypeError('tokenFlow.outbound.source is invalid');
  }
  return Object.freeze({
    upstreamToken,
    outboundToken: Object.freeze({
      value: tokenString(requiredOwnData(outbound, 'value', 'tokenFlow.outbound'), 'tokenFlow.outbound.value'),
      source: outboundSource,
    }),
  });
}

function snapshotApplicableInput(
  input: unknown,
  integration: ApplicableIntegration,
): ApplicableInputSnapshot {
  const metadata = requiredOwnData(input, 'protectedResourceMetadata', 'OAuth profile input');
  const discovery = requiredOwnData(input, 'authorizationServerDiscovery', 'OAuth profile input');
  const authorizationRequest = requiredOwnData(input, 'authorizationRequest', 'OAuth profile input');
  const tokenRequest = requiredOwnData(input, 'tokenRequest', 'OAuth profile input');
  const accessToken = requiredOwnData(input, 'accessToken', 'OAuth profile input');
  const transport = requiredOwnData(input, 'transport', 'OAuth profile input');
  const client = requiredOwnData(input, 'client', 'OAuth profile input');
  const refreshToken = requiredOwnData(input, 'refreshToken', 'OAuth profile input');
  const tokenFlowValue = requiredOwnData(input, 'tokenFlow', 'OAuth profile input');

  const discoveryMethod = requiredOwnData(discovery, 'method', 'authorizationServerDiscovery');
  if (
    discoveryMethod !== 'authorization-server-metadata' &&
    discoveryMethod !== 'openid-connect-discovery'
  ) {
    throw new TypeError('authorizationServerDiscovery.method is invalid');
  }
  const issuedAt = requiredOwnData(accessToken, 'issuedAt', 'accessToken');
  const expiresAt = requiredOwnData(accessToken, 'expiresAt', 'accessToken');
  if (typeof issuedAt !== 'number' || typeof expiresAt !== 'number') {
    throw new TypeError('accessToken NumericDate values must be numbers');
  }
  assertUnixSeconds(issuedAt, 'accessToken.issuedAt');
  assertUnixSeconds(expiresAt, 'accessToken.expiresAt');
  const clientType = requiredOwnData(client, 'type', 'client');
  if (clientType !== 'public' && clientType !== 'confidential') {
    throw new TypeError('client.type is invalid');
  }
  const tokenFlow = snapshotTokenFlow(tokenFlowValue);

  return Object.freeze({
    integration,
    resource: nonEmptyString(requiredOwnData(metadata, 'resource', 'protectedResourceMetadata'), 'resource'),
    authorizationServers: snapshotStringArray(
      requiredOwnData(metadata, 'authorizationServers', 'protectedResourceMetadata'),
      'protectedResourceMetadata.authorizationServers',
    ),
    discovery: Object.freeze({
      authorizationServer: nonEmptyString(
        requiredOwnData(discovery, 'authorizationServer', 'authorizationServerDiscovery'),
        'authorizationServer',
      ),
      method: discoveryMethod,
      discoveryUrl: nonEmptyString(
        requiredOwnData(discovery, 'discoveryUrl', 'authorizationServerDiscovery'),
        'discoveryUrl',
      ),
      issuer: nonEmptyString(requiredOwnData(discovery, 'issuer', 'authorizationServerDiscovery'), 'issuer'),
      authorizationEndpoint: nonEmptyString(
        requiredOwnData(discovery, 'authorizationEndpoint', 'authorizationServerDiscovery'),
        'authorizationEndpoint',
      ),
      tokenEndpoint: nonEmptyString(
        requiredOwnData(discovery, 'tokenEndpoint', 'authorizationServerDiscovery'),
        'tokenEndpoint',
      ),
    }),
    authorizationResources: snapshotStringOrArray(
      requiredOwnData(authorizationRequest, 'resource', 'authorizationRequest'),
      'authorizationRequest.resource',
    ),
    tokenResources: snapshotStringOrArray(
      requiredOwnData(tokenRequest, 'resource', 'tokenRequest'),
      'tokenRequest.resource',
    ),
    audiences: snapshotStringOrArray(
      requiredOwnData(accessToken, 'audience', 'accessToken'),
      'accessToken.audience',
    ),
    issuedAt,
    expiresAt,
    requestTarget: nonEmptyString(
      requiredOwnData(transport, 'requestTarget', 'transport'),
      'transport.requestTarget',
    ),
    authorizationValues: snapshotAuthorization(
      requiredOwnData(transport, 'authorization', 'transport'),
    ),
    clientType,
    pkce: snapshotPkce(ownData(client, 'pkce', 'client')),
    refreshToken: snapshotRefreshToken(refreshToken),
    upstreamToken: tokenFlow.upstreamToken,
    outboundToken: tokenFlow.outboundToken,
  });
}

function parseHttpsUri(value: string, prohibitQuery: boolean): string {
  if (
    value.length > MAX_URL_LENGTH ||
    !/^https:\/\//u.test(value) ||
    whitespace.test(value) ||
    loneSurrogate.test(value) ||
    value.includes('\\') ||
    ambiguousDotSegment.test(value) ||
    encodedPathSeparator.test(value)
  ) {
    throw new TypeError('Unsafe HTTPS URI');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new TypeError('Malformed URI percent encoding');
  }
  if (controlCharacters.test(decoded)) throw new TypeError('URI decodes to control characters');

  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname.length === 0 ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.hash.length !== 0 ||
    (prohibitQuery && url.search.length !== 0)
  ) {
    throw new TypeError('Unsafe HTTPS URI');
  }
  // URL parsing canonicalizes scheme, host casing, default ports, and some
  // escapes. Reject those alternate spellings so exact resource/audience and
  // issuer comparisons cannot silently collapse distinct wire values. A root
  // URI may omit the URL serializer's implicit trailing slash.
  const canonical = url.href;
  const rootWithoutSlash =
    url.pathname === '/' && url.search.length === 0 && canonical.endsWith('/')
      ? canonical.slice(0, -1)
      : canonical;
  if (value !== canonical && value !== rootWithoutSlash) throw new TypeError('Non-canonical HTTPS URI');
  percentEscape.lastIndex = 0;
  let escape: RegExpExecArray | null;
  while ((escape = percentEscape.exec(value)) !== null) {
    const decodedByte = Number.parseInt(escape[1]!, 16);
    if (
      (decodedByte >= 0x30 && decodedByte <= 0x39) ||
      (decodedByte >= 0x41 && decodedByte <= 0x5a) ||
      (decodedByte >= 0x61 && decodedByte <= 0x7a) ||
      decodedByte === 0x2d ||
      decodedByte === 0x2e ||
      decodedByte === 0x5f ||
      decodedByte === 0x7e
    ) {
      throw new TypeError('Encoded unreserved URI character');
    }
  }
  return value;
}

function expectedDiscoveryUrl(issuer: string, method: OAuthAuthorizationServerDiscoveryMethod): string {
  const url = new URL(issuer);
  if (method === 'authorization-server-metadata') {
    const issuerPath = url.pathname === '/' ? '' : url.pathname;
    url.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  } else {
    const issuerPath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/u, '');
    url.pathname = `${issuerPath}/.well-known/openid-configuration`;
  }
  return url.href;
}

function canonicalizeStaticProfile(
  snapshot: ApplicableInputSnapshot,
): CanonicalProfileSnapshot | OAuth21ProfileDenialReason {
  let resource: string;
  let authorizationServers: readonly string[];
  try {
    resource = parseHttpsUri(snapshot.resource, false);
    authorizationServers = Object.freeze(
      snapshot.authorizationServers.map((server) => parseHttpsUri(server, true)),
    );
    if (
      authorizationServers.length === 0 ||
      new Set(authorizationServers).size !== authorizationServers.length
    ) {
      return 'invalid_protected_resource_metadata';
    }
  } catch {
    return 'invalid_protected_resource_metadata';
  }

  let discovery: DiscoverySnapshot;
  try {
    discovery = Object.freeze({
      authorizationServer: parseHttpsUri(snapshot.discovery.authorizationServer, true),
      method: snapshot.discovery.method,
      discoveryUrl: parseHttpsUri(snapshot.discovery.discoveryUrl, true),
      issuer: parseHttpsUri(snapshot.discovery.issuer, true),
      authorizationEndpoint: parseHttpsUri(snapshot.discovery.authorizationEndpoint, false),
      tokenEndpoint: parseHttpsUri(snapshot.discovery.tokenEndpoint, false),
    });
    if (
      discovery.authorizationServer !== discovery.issuer ||
      !authorizationServers.includes(discovery.issuer) ||
      discovery.discoveryUrl !== expectedDiscoveryUrl(discovery.issuer, discovery.method)
    ) {
      return 'invalid_authorization_server_discovery';
    }
  } catch {
    return 'invalid_authorization_server_discovery';
  }

  let authorizationResources: readonly string[];
  try {
    authorizationResources = Object.freeze(
      snapshot.authorizationResources.map((value) => parseHttpsUri(value, false)),
    );
  } catch {
    return 'authorization_resource_mismatch';
  }
  if (authorizationResources.length !== 1 || authorizationResources[0] !== resource) {
    return 'authorization_resource_mismatch';
  }

  let tokenResources: readonly string[];
  try {
    tokenResources = Object.freeze(snapshot.tokenResources.map((value) => parseHttpsUri(value, false)));
  } catch {
    return 'token_resource_mismatch';
  }
  if (tokenResources.length !== 1 || tokenResources[0] !== resource) {
    return 'token_resource_mismatch';
  }

  let audiences: readonly string[];
  try {
    audiences = Object.freeze(snapshot.audiences.map((value) => parseHttpsUri(value, false)));
  } catch {
    return 'audience_mismatch';
  }
  if (audiences.length !== 1 || audiences[0] !== resource) return 'audience_mismatch';

  return Object.freeze({
    ...snapshot,
    resource,
    authorizationServers,
    discovery,
    authorizationResources,
    tokenResources,
    audiences,
  });
}

function inspectRequestTarget(requestTarget: string, bearerToken: string, authorizationValues: readonly string[]): OAuth21ProfileDenialReason | undefined {
  if (requestTarget.includes('\\') || requestTarget.includes(' ') || requestTarget.includes('#')) {
    return 'invalid_input';
  }
  let decodedTarget: string;
  try {
    decodedTarget = decodeURIComponent(requestTarget);
  } catch {
    return 'invalid_input';
  }
  if (controlCharacters.test(decodedTarget)) return 'invalid_input';

  try {
    if (requestTarget.startsWith('/')) {
      new URL(requestTarget, 'https://transport.invalid');
    } else if (/^https:\/\//u.test(requestTarget)) {
      const absolute = new URL(requestTarget);
      if (absolute.username.length !== 0 || absolute.password.length !== 0) return 'invalid_input';
    } else {
      return 'invalid_input';
    }
  } catch {
    return 'invalid_input';
  }

  const queryIndex = requestTarget.indexOf('?');
  if (queryIndex === -1) return undefined;
  const entries = Array.from(new URLSearchParams(requestTarget.slice(queryIndex + 1)));
  if (entries.length > MAX_QUERY_ENTRIES) return 'invalid_input';
  return credentialQueryDenial(entries, bearerToken, authorizationValues);
}

function secretEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function inspectAuthorization(
  values: readonly string[],
  upstreamToken: string,
): OAuth21ProfileDenialReason | undefined {
  if (values.length !== 1) return 'invalid_authorization';
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+={0,})$/iu.exec(values[0]!);
  if (match === null || !token68.test(match[1]!) || !secretEqual(match[1]!, upstreamToken)) {
    return 'invalid_authorization';
  }
  return undefined;
}

function inspectPkce(snapshot: ApplicableInputSnapshot): OAuth21ProfileDenialReason | undefined {
  if (snapshot.clientType === 'confidential' && snapshot.pkce === undefined) return undefined;
  if (
    snapshot.pkce === undefined ||
    snapshot.pkce.challengeMethod !== 'S256' ||
    !pkceVerifier.test(snapshot.pkce.verifier) ||
    !pkceChallenge.test(snapshot.pkce.challenge)
  ) {
    return 'pkce_s256_required';
  }
  const expectedChallenge = createHash('sha256')
    .update(snapshot.pkce.verifier, 'ascii')
    .digest('base64url');
  return secretEqual(expectedChallenge, snapshot.pkce.challenge) ? undefined : 'pkce_s256_required';
}

function inspectLifetime(snapshot: ApplicableInputSnapshot): OAuth21ProfileDenialReason | undefined {
  if (
    !Number.isSafeInteger(snapshot.issuedAt) ||
    !Number.isSafeInteger(snapshot.expiresAt) ||
    snapshot.issuedAt < 0 ||
    snapshot.expiresAt <= snapshot.issuedAt
  ) {
    return 'access_token_lifetime_invalid';
  }
  return snapshot.expiresAt - snapshot.issuedAt > OAUTH_ACCESS_TOKEN_TTL_CEILING_SECONDS
    ? 'access_token_ttl_exceeded'
    : undefined;
}

function inspectRefreshToken(snapshot: ApplicableInputSnapshot): OAuth21ProfileDenialReason | undefined {
  const evidence = snapshot.refreshToken;
  if (!evidence.issued) {
    return evidence.rotation === 'none' &&
      evidence.previousToken === undefined &&
      evidence.currentToken === undefined
      ? undefined
      : 'refresh_token_rotation_required';
  }
  if (
    evidence.rotation !== 'rotate-on-use' ||
    evidence.previousToken === undefined ||
    evidence.currentToken === undefined ||
    secretEqual(evidence.previousToken, evidence.currentToken)
  ) {
    return 'refresh_token_rotation_required';
  }
  return undefined;
}

function inspectTokenPassthrough(snapshot: ApplicableInputSnapshot): OAuth21ProfileDenialReason | undefined {
  const outbound = snapshot.outboundToken;
  if (outbound === undefined) return undefined;
  if (outbound.source === 'upstream' || secretEqual(snapshot.upstreamToken.value, outbound.value)) {
    return 'token_passthrough_forbidden';
  }
  return undefined;
}

function snapshotProvenanceMethod(
  ports: unknown,
): (input: OAuthAuthorizationServerProvenanceCheck) => unknown {
  const port = requiredOwnData(ports, 'authorizationServerProvenance', 'OAuth profile ports');
  if (!isRecord(port)) throw new TypeError('authorizationServerProvenance must be an object');
  rejectProxy(port, 'authorizationServerProvenance');

  let owner: object | null = port;
  while (owner !== null && owner !== Object.prototype) {
    rejectProxy(owner, 'authorizationServerProvenance prototype');
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'isAuthorized');
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new TypeError('authorizationServerProvenance.isAuthorized must be a data method');
      }
      const method = descriptor.value as (input: OAuthAuthorizationServerProvenanceCheck) => unknown;
      if (nodeTypes.isProxy(method)) {
        throw new TypeError('authorizationServerProvenance.isAuthorized must not be a Proxy');
      }
      return (input) => Reflect.apply(method, port, [input]);
    }
    owner = Object.getPrototypeOf(owner);
  }
  throw new TypeError('authorizationServerProvenance.isAuthorized is required');
}

/**
 * Enforce the complete OAuth 2.1 profile for applicable integrations. This is
 * a policy boundary only: adapters remain responsible for discovery and token verification.
 */
export async function enforceOAuth21Profile(
  ports: OAuth21ProfilePorts,
  input: OAuth21ProfileInput,
): Promise<OAuth21ProfileDecision> {
  let applicability: ApplicabilitySnapshot;
  try {
    applicability = snapshotApplicability(input);
  } catch {
    return denied('unknown', 'invalid_input');
  }

  const isApplicableIntegration = applicableIntegrations.has(applicability.integration);
  if (
    (isApplicableIntegration && applicability.applicability !== 'applicable') ||
    (!isApplicableIntegration && applicability.applicability !== 'not-applicable')
  ) {
    return denied(
      isApplicableIntegration ? (applicability.integration as ApplicableIntegration) : 'unknown',
      'applicability_mismatch',
    );
  }
  if (!isApplicableIntegration) {
    return notApplicableDecisions[applicability.integration as NotApplicableIntegration];
  }

  const integration = applicability.integration as ApplicableIntegration;
  let snapshot: ApplicableInputSnapshot;
  try {
    snapshot = snapshotApplicableInput(input, integration);
  } catch {
    return denied(integration, 'invalid_input');
  }

  const canonical = canonicalizeStaticProfile(snapshot);
  if (typeof canonical === 'string') return denied(integration, canonical);

  const requestTargetDenial = inspectRequestTarget(canonical.requestTarget, canonical.upstreamToken.value, canonical.authorizationValues);
  if (requestTargetDenial !== undefined) return denied(integration, requestTargetDenial);
  const authorizationDenial = inspectAuthorization(
    canonical.authorizationValues,
    canonical.upstreamToken.value,
  );
  if (authorizationDenial !== undefined) return denied(integration, authorizationDenial);
  const pkceDenial = inspectPkce(canonical);
  if (pkceDenial !== undefined) return denied(integration, pkceDenial);
  const lifetimeDenial = inspectLifetime(canonical);
  if (lifetimeDenial !== undefined) return denied(integration, lifetimeDenial);
  const refreshTokenDenial = inspectRefreshToken(canonical);
  if (refreshTokenDenial !== undefined) return denied(integration, refreshTokenDenial);
  const passthroughDenial = inspectTokenPassthrough(canonical);
  if (passthroughDenial !== undefined) return denied(integration, passthroughDenial);

  let isAuthorizedMethod: (input: OAuthAuthorizationServerProvenanceCheck) => unknown;
  try {
    isAuthorizedMethod = snapshotProvenanceMethod(ports);
  } catch {
    return denied(integration, 'port_failure');
  }
  const check = Object.freeze({
    resource: canonical.resource,
    authorizationServer: canonical.discovery.authorizationServer,
    method: canonical.discovery.method,
    discoveryUrl: canonical.discovery.discoveryUrl,
    issuer: canonical.discovery.issuer,
    authorizationEndpoint: canonical.discovery.authorizationEndpoint,
    tokenEndpoint: canonical.discovery.tokenEndpoint,
  });
  let result: unknown;
  try {
    const pending = isAuthorizedMethod(check);
    if (!nodeTypes.isPromise(pending)) return denied(integration, 'port_failure');
    // Use the intrinsic Promise brand and method rather than awaiting the
    // value directly: native Promise subclasses can override `then`, while
    // cross-realm native Promises still satisfy the Node brand check.
    const settled = new Promise<unknown>((resolve, reject) => {
      Reflect.apply(Promise.prototype.then, pending, [resolve, reject]);
    });
    result = await settled;
  } catch {
    return denied(integration, 'port_failure');
  }
  if (typeof result !== 'boolean') return denied(integration, 'port_failure');
  if (!result) return denied(integration, 'discovery_not_authorized');
  return enforcedDecisions[integration];
}
