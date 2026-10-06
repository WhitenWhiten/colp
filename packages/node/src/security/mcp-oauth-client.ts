/**
 * MCP OAuth client security (SEC-0019).
 *
 * Security/client adapter for the modern MCP `2026-07-28` OAuth client. This
 * module is protocol-neutral-first but is explicitly the OAuth client
 * security/adapter layer, so it may use the allowlisted SDK OAuth types
 * re-exported by `src/mcp/2026-07-28/sdk-boundary.ts` (see
 * `docs/MCP_SDK_POLICY.md`). It never imports `@modelcontextprotocol/client`.
 *
 * Contract families:
 * - RFC 9207 authorization-response `iss` validation: missing (when the AS
 *   metadata requires it), swap (a different `iss` echo) and mix-up (the
 *   token-exchange issuer differs from the issuer recorded at authorization
 *   time) are all denied.
 * - RFC 8414 authorization-server metadata validation: exact https issuer
 *   (loopback http tolerated), required authorization/token endpoints, DCR
 *   registration endpoint when dynamic registration is required, and PKCE
 *   S256 support.
 * - RFC 7591 DCR: `application_type` is always declared and derived from the
 *   deployment type (web vs native via loopback/custom-scheme redirect URIs).
 * - Issuer-keyed credential and refresh-state isolation: credentials and
 *   refresh tokens are selected under an exact issuer key (syntax-validated
 *   via {@link canonicalOAuthIssuer}); the same client credentials must never
 *   be reused across issuers and refresh rotation rejects reuse of an
 *   already-rotated token.
 * - Redirect-URI exact-match and PKCE S256 checks.
 * - Secret storage/logging discipline: decisions and log output never carry
 *   token/secret values; the credential vault and token store are explicit
 *   gateway-owned ports that the Read application client never receives
 *   (`McpReadClientGatewayPort` keeps owning transport + OAuth composition).
 * - stdio / API Key / local hosts are marked not-applicable so they stay on
 *   their non-OAuth paths.
 */
import { createHash } from 'node:crypto';

import { canonicalOAuthIssuer, isLoopbackHost } from './mcp-oauth-discovery.js';
export {
  canonicalOAuthIssuer,
  enforceOAuthAuthorizationResponseIss,
  enforceOAuthAuthorizationServerMetadata,
  enforceOAuthTokenExchangeIssuer,
  type OAuthAuthorizationResponseIssInput,
  type OAuthAuthorizationResponseIssDenialReason,
  type OAuthAuthorizationResponseIssDecision,
  type OAuthTokenExchangeIssuerInput,
  type OAuthTokenExchangeIssuerDenialReason,
  type OAuthTokenExchangeIssuerDecision,
  type OAuthAuthorizationServerMetadataSnapshot,
  type OAuthAuthorizationServerMetadataDenialReason,
  type OAuthAuthorizationServerMetadataDecision,
  type OAuthAuthorizationServerMetadataOptions,
} from './mcp-oauth-discovery.js';

import { OAuthClientMetadataSchema } from '../shared/mcp-sdk-boundary.js';
import {
  assertPlainRecord,
  exactOwnStringKeys,
  readOwnDataProperty,
  requireOwnDataProperty,
  snapshotDenseArray,
} from './input-snapshot.js';

/**
 * COLP-owned RFC 7591 DCR client-metadata document. Structurally mirrors the
 * SDK's `OAuthClientMetadataSchema` inference (the readable SDK type name is
 * a dev-only client export; the schema itself is allowlisted from core and
 * used at runtime to validate the built document).
 */
export interface OAuthClientMetadataDocument {
  readonly redirect_uris: readonly string[];
  readonly application_type: 'web' | 'native';
  readonly token_endpoint_auth_method: 'none' | 'client_secret_basic' | 'client_secret_post';
  readonly grant_types: readonly string[];
  readonly response_types: readonly string[];
  readonly client_name?: string;
}

/**
 * COLP-owned stored OAuth tokens keyed by exact issuer (mirrors the SDK's
 * stored-token shape: the wire token fields plus an SDK/COLP-stamped
 * `issuer`). Raw token values live only in the gateway-owned token store and
 * never enter a binding or a log line.
 */
export interface OAuthStoredTokens {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly issuer?: string;
}

/**
 * COLP-owned stored OAuth client credentials keyed by exact issuer
 * (mirrors the SDK's stored client-information shape plus an `issuer`
 * stamp). The client secret lives only in the gateway-owned credential vault.
 */
export interface OAuthStoredClientCredentials {
  readonly client_id: string;
  readonly client_secret?: string;
  readonly client_id_issued_at?: number;
  readonly client_secret_expires_at?: number;
  readonly redirect_uris?: readonly string[];
  readonly application_type?: 'web' | 'native';
  readonly token_endpoint_auth_method?: string;
  readonly issuer?: string;
}

// =====================================================================
// OAuth client applicability (stdio / API Key hosts are not-applicable)
// =====================================================================

/** Host kinds the MCP OAuth client adapter recognises. */
export type OAuthClientHostKind =
  | 'remote-mcp'
  | 'local-mcp'
  | 'stdio'
  | 'api-key'
  | 'service'
  | 'other';

/** Stable reason for a not-applicable OAuth host. */
export type OAuthClientNotApplicableReason =
  | 'stdio_local_credentials'
  | 'api_key_credentials'
  | 'local_mcp_credentials'
  | 'service_credentials'
  | 'unsupported_host';

/** Applicability decision for one MCP host kind. */
export type OAuthClientApplicabilityDecision =
  | {
      readonly allowed: true;
      readonly disposition: 'applicable';
      readonly hostKind: 'remote-mcp';
      readonly reason: 'oauth_applicable';
    }
  | {
      readonly allowed: true;
      readonly disposition: 'not-applicable';
      readonly hostKind: Exclude<OAuthClientHostKind, 'remote-mcp'>;
      readonly reason: OAuthClientNotApplicableReason;
    };

const HOST_KINDS = new Set<OAuthClientHostKind>([
  'remote-mcp',
  'local-mcp',
  'stdio',
  'api-key',
  'service',
  'other',
]);

/**
 * Classify whether a host kind uses the OAuth client flow. Only remote MCP is
 * applicable; stdio and API Key hosts use their local/API-key credential paths
 * and must never enter the OAuth client flow.
 */
export function classifyOAuthClientApplicability(
  hostKind: OAuthClientHostKind,
): OAuthClientApplicabilityDecision {
  if (!HOST_KINDS.has(hostKind)) {
    return Object.freeze({
      allowed: true,
      disposition: 'not-applicable',
      hostKind: 'other',
      reason: 'unsupported_host',
    } as const);
  }
  switch (hostKind) {
    case 'remote-mcp':
      return Object.freeze({
        allowed: true,
        disposition: 'applicable',
        hostKind,
        reason: 'oauth_applicable',
      } as const);
    case 'stdio':
      return Object.freeze({
        allowed: true,
        disposition: 'not-applicable',
        hostKind,
        reason: 'stdio_local_credentials',
      } as const);
    case 'api-key':
      return Object.freeze({
        allowed: true,
        disposition: 'not-applicable',
        hostKind,
        reason: 'api_key_credentials',
      } as const);
    case 'local-mcp':
      return Object.freeze({
        allowed: true,
        disposition: 'not-applicable',
        hostKind,
        reason: 'local_mcp_credentials',
      } as const);
    case 'service':
      return Object.freeze({
        allowed: true,
        disposition: 'not-applicable',
        hostKind,
        reason: 'service_credentials',
      } as const);
    default:
      return Object.freeze({
        allowed: true,
        disposition: 'not-applicable',
        hostKind: 'other',
        reason: 'unsupported_host',
      } as const);
  }
}

// =====================================================================
// RFC 7591 DCR application_type
// =====================================================================

/** OAuth client deployment type used to derive DCR `application_type`. */
export type OAuthClientDeploymentType = 'web' | 'native';

/**
 * Derive the RFC 7591 `application_type` from redirect URIs: loopback hosts
 * (RFC 8252 §7.3) and custom (non-http(s)) URI schemes are native; everything
 * else is web. An explicitly provided deployment type always wins.
 */
export function resolveOAuthApplicationType(
  redirectUris: readonly string[],
  deploymentType?: OAuthClientDeploymentType,
): OAuthClientDeploymentType {
  if (deploymentType !== undefined) {
    if (deploymentType !== 'web' && deploymentType !== 'native') {
      throw new TypeError('deploymentType must be "web" or "native"');
    }
    return deploymentType;
  }
  return redirectUris.some(isNativeRedirectUri) ? 'native' : 'web';
}

function isNativeRedirectUri(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return true;
  return isLoopbackHost(url.hostname);
}

function assertDcrRedirectUri(redirectUri: string): URL {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new TypeError('DCR redirectUri must be an absolute URL');
  }
  if (url.protocol === 'javascript:' || url.protocol === 'data:') {
    throw new TypeError('DCR redirectUri must not use a scriptable scheme');
  }
  return url;
}

/** Input for {@link buildOAuthDcrClientMetadata}. */
export interface OAuthDcrClientMetadataInput {
  readonly redirectUris: readonly string[];
  readonly deploymentType?: OAuthClientDeploymentType;
  readonly clientName?: string;
  readonly tokenEndpointAuthMethod?: 'none' | 'client_secret_basic' | 'client_secret_post';
  readonly grantTypes?: readonly string[];
}

const DCR_INPUT_KEYS = Object.freeze([
  'redirectUris',
  'deploymentType',
  'clientName',
  'tokenEndpointAuthMethod',
  'grantTypes',
]);

const TOKEN_ENDPOINT_AUTH_METHODS = new Set(['none', 'client_secret_basic', 'client_secret_post']);

/**
 * Build the RFC 7591 dynamic-client-registration metadata body. Always
 * declares `application_type` (web/native), `redirect_uris`, `response_types`
 * and `grant_types` so the AS can issue a refresh token and correctly classify
 * the client.
 */
export function buildOAuthDcrClientMetadata(input: unknown): OAuthClientMetadataDocument {
  assertPlainRecord(input, 'DCR metadata input');
  exactOwnStringKeys(input, DCR_INPUT_KEYS, 'DCR metadata input');
  const redirectUrisField = requireOwnDataProperty(input, 'redirectUris', 'DCR redirectUris');
  const redirectUris = snapshotDenseArray(redirectUrisField, 'DCR redirectUris') as readonly string[];
  if (redirectUris.length === 0 || !redirectUris.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    throw new TypeError('DCR redirectUris must be a non-empty array of strings');
  }
  for (const redirectUri of redirectUris) {
    assertDcrRedirectUri(redirectUri);
  }

  const deploymentTypeField = readOwnDataProperty(input, 'deploymentType');
  let deploymentType: OAuthClientDeploymentType | undefined;
  if (deploymentTypeField.found && deploymentTypeField.value !== undefined) {
    const value = deploymentTypeField.value;
    if (value !== 'web' && value !== 'native') {
      throw new TypeError('DCR deploymentType must be "web" or "native"');
    }
    deploymentType = value;
  }
  const applicationType = resolveOAuthApplicationType(redirectUris, deploymentType);

  const clientNameField = readOwnDataProperty(input, 'clientName');
  const clientName = clientNameField.found && clientNameField.value !== undefined
    ? clientNameField.value
    : undefined;
  if (clientName !== undefined && typeof clientName !== 'string') {
    throw new TypeError('DCR clientName must be a string');
  }

  const authMethodField = readOwnDataProperty(input, 'tokenEndpointAuthMethod');
  const authMethodValue = authMethodField.found && authMethodField.value !== undefined
    ? authMethodField.value
    : undefined;
  if (
    authMethodValue !== undefined
    && (typeof authMethodValue !== 'string' || !TOKEN_ENDPOINT_AUTH_METHODS.has(authMethodValue))
  ) {
    throw new TypeError('DCR tokenEndpointAuthMethod is not supported');
  }
  const tokenEndpointAuthMethod = authMethodValue as
    | 'none'
    | 'client_secret_basic'
    | 'client_secret_post'
    | undefined;

  const grantTypesField = readOwnDataProperty(input, 'grantTypes');
  let grantTypes: readonly string[] | undefined;
  if (grantTypesField.found && grantTypesField.value !== undefined) {
    grantTypes = snapshotDenseArray(grantTypesField.value, 'DCR grantTypes') as readonly string[];
    if (!grantTypes.every((entry) => typeof entry === 'string' && entry.length > 0)) {
      throw new TypeError('DCR grantTypes entries must be non-empty strings');
    }
  }

  const metadata: OAuthClientMetadataDocument = Object.freeze({
    redirect_uris: [...redirectUris],
    application_type: applicationType,
    token_endpoint_auth_method: tokenEndpointAuthMethod ?? 'none',
    grant_types: [...(grantTypes ?? ['authorization_code', 'refresh_token'])],
    response_types: ['code'],
    ...(clientName !== undefined ? { client_name: clientName } : {}),
  });
  // Source-bound check: the built DCR body must satisfy the pinned SDK's
  // RFC 7591 client-metadata schema (fail closed on any drift).
  const parsed = OAuthClientMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    throw new TypeError('built DCR client metadata failed SDK schema validation');
  }
  return metadata;
}

export type OAuthDcrApplicationTypeDenialReason =
  | 'invalid_input'
  | 'missing_application_type'
  | 'application_type_mismatch';

export type OAuthDcrApplicationTypeDecision =
  | {
      readonly allowed: true;
      readonly reason: 'application_type_matches';
      readonly applicationType: OAuthClientDeploymentType;
    }
  | { readonly allowed: false; readonly reason: OAuthDcrApplicationTypeDenialReason };

/**
 * Enforce that a DCR response/metadata document declares `application_type`
 * and that it matches the deployment type COLP selected.
 */
export function enforceOAuthDcrApplicationType(
  metadata: unknown,
  expectedDeploymentType: OAuthClientDeploymentType,
): OAuthDcrApplicationTypeDecision {
  if (expectedDeploymentType !== 'web' && expectedDeploymentType !== 'native') {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  let applicationTypeValue: unknown;
  try {
    assertPlainRecord(metadata, 'DCR metadata');
    const applicationType = readOwnDataProperty(metadata, 'application_type');
    applicationTypeValue = applicationType.found && applicationType.value !== undefined
      ? applicationType.value
      : undefined;
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  if (applicationTypeValue === undefined) {
    return Object.freeze({ allowed: false, reason: 'missing_application_type' } as const);
  }
  if (applicationTypeValue !== 'web' && applicationTypeValue !== 'native') {
    return Object.freeze({ allowed: false, reason: 'application_type_mismatch' } as const);
  }
  if (applicationTypeValue !== expectedDeploymentType) {
    return Object.freeze({ allowed: false, reason: 'application_type_mismatch' } as const);
  }
  return Object.freeze({
    allowed: true,
    reason: 'application_type_matches',
    applicationType: applicationTypeValue,
  } as const);
}

// =====================================================================
// Issuer-keyed credential isolation
// =====================================================================

/** An OAuth client credential record keyed by its registration issuer. */
export interface OAuthIssuerKeyedClientCredential {
  /** Exact registration issuer; credentials never cross issuers. */
  readonly issuer: string;
  readonly clientId: string;
  /** Stored in the secret vault; never logged or placed in a binding. */
  readonly clientSecret?: string;
  readonly credentialBindingId: string;
}

/** Stable key under which credentials and refresh state are stored. */
export function oauthCredentialStoreKey(issuer: string): string {
  return canonicalOAuthIssuer(issuer);
}

/** Select the credential registered for the exact issuer. */
export function selectOAuthClientCredentialForIssuer(
  credentials: readonly OAuthIssuerKeyedClientCredential[],
  issuer: string,
): OAuthIssuerKeyedClientCredential | undefined {
  const key = oauthCredentialStoreKey(issuer);
  return credentials.find((credential) => oauthCredentialStoreKey(credential.issuer) === key);
}

export type OAuthCredentialIssuerIsolationDenialReason =
  | 'invalid_input'
  | 'credential_issuer_missing'
  | 'credential_issuer_mismatch';

export type OAuthCredentialIssuerIsolationDecision =
  | {
      readonly allowed: true;
      readonly reason: 'credential_issuer_matches';
      readonly credentialBindingId: string;
    }
  | { readonly allowed: false; readonly reason: OAuthCredentialIssuerIsolationDenialReason };

const CREDENTIAL_KEYS = Object.freeze(['issuer', 'clientId', 'clientSecret', 'credentialBindingId']);

function snapshotCredential(credential: unknown): OAuthIssuerKeyedClientCredential {
  assertPlainRecord(credential, 'OAuth client credential');
  exactOwnStringKeys(credential, CREDENTIAL_KEYS, 'OAuth client credential');
  const issuer = requireOwnDataProperty(credential, 'issuer', 'credential issuer');
  const clientId = requireOwnDataProperty(credential, 'clientId', 'credential clientId');
  const credentialBindingId = requireOwnDataProperty(
    credential,
    'credentialBindingId',
    'credential credentialBindingId',
  );
  const clientSecret = readOwnDataProperty(credential, 'clientSecret');
  if (typeof issuer !== 'string' || typeof clientId !== 'string' || typeof credentialBindingId !== 'string') {
    throw new TypeError('credential identifiers must be strings');
  }
  const clientSecretValue = clientSecret.found && clientSecret.value !== undefined
    ? clientSecret.value
    : undefined;
  if (clientSecretValue !== undefined && typeof clientSecretValue !== 'string') {
    throw new TypeError('credential clientSecret must be a string');
  }
  return Object.freeze({
    issuer,
    clientId,
    credentialBindingId,
    ...(clientSecretValue !== undefined ? { clientSecret: clientSecretValue } : {}),
  });
}

/**
 * Enforce issuer-keyed credential isolation (SEC-0019): a client_id /
 * client_secret registered for one authorization server must never be reused
 * for another. On issuer change the client must re-register (DCR).
 */
export function enforceOAuthCredentialIssuerIsolation(
  credential: unknown,
  issuer: string,
): OAuthCredentialIssuerIsolationDecision {
  let snapshot: OAuthIssuerKeyedClientCredential;
  try {
    snapshot = snapshotCredential(credential);
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  if (snapshot.issuer.length === 0) {
    return Object.freeze({ allowed: false, reason: 'credential_issuer_missing' } as const);
  }
  let credentialKey: string;
  let targetKey: string;
  try {
    credentialKey = oauthCredentialStoreKey(snapshot.issuer);
    targetKey = oauthCredentialStoreKey(issuer);
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  if (credentialKey !== targetKey) {
    return Object.freeze({ allowed: false, reason: 'credential_issuer_mismatch' } as const);
  }
  return Object.freeze({
    allowed: true,
    reason: 'credential_issuer_matches',
    credentialBindingId: snapshot.credentialBindingId,
  } as const);
}

// =====================================================================
// Refresh-token rotation and issuer-bound refresh state
// =====================================================================

/** Refresh state keyed by the issuer that issued the tokens. */
export interface OAuthIssuerKeyedRefreshState {
  readonly issuer: string;
  readonly currentRefreshToken: string;
}

/** Select the refresh state stored for the exact issuer. */
export function selectOAuthRefreshStateForIssuer(
  states: readonly OAuthIssuerKeyedRefreshState[],
  issuer: string,
): OAuthIssuerKeyedRefreshState | undefined {
  const key = oauthCredentialStoreKey(issuer);
  return states.find((state) => oauthCredentialStoreKey(state.issuer) === key);
}

export type OAuthRefreshRotationDenialReason =
  | 'invalid_input'
  | 'refresh_token_missing'
  | 'refresh_token_reuse'
  | 'refresh_token_not_rotated'
  | 'refresh_issuer_mismatch';

export type OAuthRefreshRotationDecision =
  | {
      readonly allowed: true;
      readonly reason: 'rotated';
      readonly nextState: OAuthIssuerKeyedRefreshState;
    }
  | { readonly allowed: false; readonly reason: OAuthRefreshRotationDenialReason };

const REFRESH_STATE_KEYS = Object.freeze(['issuer', 'currentRefreshToken']);

function snapshotRefreshState(state: unknown): OAuthIssuerKeyedRefreshState {
  assertPlainRecord(state, 'OAuth refresh state');
  exactOwnStringKeys(state, REFRESH_STATE_KEYS, 'OAuth refresh state');
  const issuer = requireOwnDataProperty(state, 'issuer', 'refresh state issuer');
  const currentRefreshToken = requireOwnDataProperty(
    state,
    'currentRefreshToken',
    'refresh state currentRefreshToken',
  );
  if (typeof issuer !== 'string' || typeof currentRefreshToken !== 'string') {
    throw new TypeError('refresh state fields must be strings');
  }
  return Object.freeze({ issuer, currentRefreshToken });
}

/**
 * Rotate the refresh token for an issuer-keyed state. The presented refresh
 * token must be the current one (reuse of an already-rotated token is denied),
 * the issuer must match the exchange issuer, and the rotation must actually
 * produce a new token value.
 */
export function rotateOAuthRefreshToken(
  state: unknown,
  presentedRefreshToken: string,
  nextRefreshToken: string,
  exchangeIssuer: string,
): OAuthRefreshRotationDecision {
  let snapshot: OAuthIssuerKeyedRefreshState;
  try {
    snapshot = snapshotRefreshState(state);
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  if (typeof presentedRefreshToken !== 'string' || presentedRefreshToken.length === 0) {
    return Object.freeze({ allowed: false, reason: 'refresh_token_missing' } as const);
  }
  if (typeof nextRefreshToken !== 'string' || nextRefreshToken.length === 0) {
    return Object.freeze({ allowed: false, reason: 'refresh_token_missing' } as const);
  }
  if (typeof exchangeIssuer !== 'string' || exchangeIssuer.length === 0) {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  let stateKey: string;
  let exchangeKey: string;
  try {
    stateKey = oauthCredentialStoreKey(snapshot.issuer);
    exchangeKey = oauthCredentialStoreKey(exchangeIssuer);
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  if (stateKey !== exchangeKey) {
    return Object.freeze({ allowed: false, reason: 'refresh_issuer_mismatch' } as const);
  }
  if (presentedRefreshToken !== snapshot.currentRefreshToken) {
    return Object.freeze({ allowed: false, reason: 'refresh_token_reuse' } as const);
  }
  if (nextRefreshToken === presentedRefreshToken) {
    return Object.freeze({ allowed: false, reason: 'refresh_token_not_rotated' } as const);
  }
  return Object.freeze({
    allowed: true,
    reason: 'rotated',
    nextState: Object.freeze({ issuer: stateKey, currentRefreshToken: nextRefreshToken }),
  } as const);
}

// =====================================================================
// Redirect URI and PKCE S256
// =====================================================================

export type OAuthRedirectUriDenialReason = 'invalid_input' | 'redirect_uri_missing' | 'redirect_uri_mismatch';

export type OAuthRedirectUriDecision =
  | { readonly allowed: true; readonly reason: 'redirect_uri_matches' }
  | { readonly allowed: false; readonly reason: OAuthRedirectUriDenialReason };

/**
 * Enforce exact redirect-URI matching (RFC 6749 §3.1.2): the presented
 * redirect URI must equal one of the registered redirect URIs byte-for-byte.
 */
export function enforceOAuthRedirectUri(
  registeredRedirectUris: readonly string[],
  presentedRedirectUri: string,
): OAuthRedirectUriDecision {
  let registered: readonly string[];
  try {
    registered = snapshotDenseArray(registeredRedirectUris, 'registered redirect URIs') as readonly string[];
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  if (!registered.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  if (typeof presentedRedirectUri !== 'string' || presentedRedirectUri.length === 0) {
    return Object.freeze({ allowed: false, reason: 'redirect_uri_missing' } as const);
  }
  if (!registered.includes(presentedRedirectUri)) {
    return Object.freeze({ allowed: false, reason: 'redirect_uri_mismatch' } as const);
  }
  return Object.freeze({ allowed: true, reason: 'redirect_uri_matches' } as const);
}

/** PKCE evidence to validate (RFC 7636). */
export interface OAuthPkceInput {
  readonly verifier: string;
  readonly challenge: string;
  readonly challengeMethod: string;
}

export type OAuthPkceDenialReason =
  | 'invalid_input'
  | 'pkce_challenge_method_not_s256'
  | 'pkce_verifier_invalid'
  | 'pkce_challenge_mismatch';

export type OAuthPkceDecision =
  | { readonly allowed: true; readonly reason: 'pkce_s256_matches' }
  | { readonly allowed: false; readonly reason: OAuthPkceDenialReason };

const PKCE_INPUT_KEYS = Object.freeze(['verifier', 'challenge', 'challengeMethod']);
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/u;

function snapshotPkce(input: unknown): OAuthPkceInput {
  assertPlainRecord(input, 'PKCE input');
  exactOwnStringKeys(input, PKCE_INPUT_KEYS, 'PKCE input');
  const verifier = requireOwnDataProperty(input, 'verifier', 'PKCE verifier');
  const challenge = requireOwnDataProperty(input, 'challenge', 'PKCE challenge');
  const challengeMethod = requireOwnDataProperty(input, 'challengeMethod', 'PKCE challengeMethod');
  if (
    typeof verifier !== 'string'
    || typeof challenge !== 'string'
    || typeof challengeMethod !== 'string'
  ) {
    throw new TypeError('PKCE fields must be strings');
  }
  return Object.freeze({ verifier, challenge, challengeMethod });
}

/**
 * Enforce PKCE S256 for public clients: the challenge method must be S256, the
 * verifier must satisfy the RFC 7636 charset/length, and the challenge must
 * equal base64url(sha256(verifier)).
 */
export function enforceOAuthPkce(input: unknown): OAuthPkceDecision {
  let snapshot: OAuthPkceInput;
  try {
    snapshot = snapshotPkce(input);
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_input' } as const);
  }
  if (snapshot.challengeMethod !== 'S256') {
    return Object.freeze({ allowed: false, reason: 'pkce_challenge_method_not_s256' } as const);
  }
  if (!PKCE_VERIFIER.test(snapshot.verifier)) {
    return Object.freeze({ allowed: false, reason: 'pkce_verifier_invalid' } as const);
  }
  const expectedChallenge = createHash('sha256').update(snapshot.verifier).digest('base64url');
  if (snapshot.challenge !== expectedChallenge) {
    return Object.freeze({ allowed: false, reason: 'pkce_challenge_mismatch' } as const);
  }
  return Object.freeze({ allowed: true, reason: 'pkce_s256_matches' } as const);
}

// =====================================================================
// Secret storage / logging discipline
// =====================================================================

/** Stable redaction marker; never reveals the secret's length or content. */
export const OAUTH_SECRET_REDACTION = '[redacted:oauth-credential]' as const;

/** Redact any credential value to a stable non-secret marker. */
export function redactOAuthCredential(value: string): string {
  if (typeof value !== 'string') {
    throw new TypeError('redactOAuthCredential expects a string');
  }
  return OAUTH_SECRET_REDACTION;
}

/** Operation label for safe OAuth log context. */
export type OAuthLogOperation =
  | 'authorization-request'
  | 'authorization-response'
  | 'token-exchange'
  | 'refresh'
  | 'dcr'
  | 'applicability';

/** Stable identifiers only — never tokens or client secrets. */
export interface OAuthLogSafeContext {
  readonly issuer: string;
  readonly clientId: string;
  readonly operation: OAuthLogOperation;
  readonly outcome: 'allowed' | 'denied';
  /** Stable denial reason code; free-form text is never embedded. */
  readonly reason?: string;
}

const OAUTH_LOG_OPERATIONS = new Set<OAuthLogOperation>([
  'authorization-request',
  'authorization-response',
  'token-exchange',
  'refresh',
  'dcr',
  'applicability',
]);

/**
 * All stable denial reason codes this module can emit. `formatOAuthLogContext`
 * only embeds a reason when it is one of these codes, so attacker-controlled
 * or accidental secret material can never reach the log through the reason
 * slot.
 */
export const OAUTH_CLIENT_SECURITY_REASON_CODES = Object.freeze([
  'invalid_input',
  'issuer_missing',
  'issuer_swap',
  'issuer_mixup',
  'invalid_issuer',
  'insecure_issuer',
  'issuer_has_query_or_fragment',
  'missing_authorization_endpoint',
  'invalid_authorization_endpoint',
  'insecure_authorization_endpoint',
  'missing_token_endpoint',
  'invalid_token_endpoint',
  'insecure_token_endpoint',
  'missing_registration_endpoint',
  'invalid_registration_endpoint',
  'response_types_invalid',
  'code_challenge_methods_invalid',
  'pkce_s256_not_supported',
  'missing_application_type',
  'application_type_mismatch',
  'credential_issuer_missing',
  'credential_issuer_mismatch',
  'refresh_token_missing',
  'refresh_token_reuse',
  'refresh_token_not_rotated',
  'refresh_issuer_mismatch',
  'redirect_uri_missing',
  'redirect_uri_mismatch',
  'pkce_challenge_method_not_s256',
  'pkce_verifier_invalid',
  'pkce_challenge_mismatch',
] as const);

const OAUTH_LOG_SAFE_REASONS = new Set<string>(OAUTH_CLIENT_SECURITY_REASON_CODES);

/**
 * Format a log line from stable identifiers only (issuer, clientId, operation,
 * outcome, stable reason code). Token values, client secrets and free-form
 * reason text are never embedded.
 */
export function formatOAuthLogContext(context: OAuthLogSafeContext): string {
  assertPlainRecord(context, 'OAuth log context');
  exactOwnStringKeys(
    context,
    ['issuer', 'clientId', 'operation', 'outcome', 'reason'],
    'OAuth log context',
  );
  const issuer = requireOwnDataProperty(context, 'issuer', 'log issuer');
  const clientId = requireOwnDataProperty(context, 'clientId', 'log clientId');
  const operation = requireOwnDataProperty(context, 'operation', 'log operation');
  const outcome = requireOwnDataProperty(context, 'outcome', 'log outcome');
  if (typeof issuer !== 'string' || issuer.length === 0) {
    throw new TypeError('log issuer must be a non-empty string');
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new TypeError('log clientId must be a non-empty string');
  }
  if (typeof operation !== 'string' || !OAUTH_LOG_OPERATIONS.has(operation as OAuthLogOperation)) {
    throw new TypeError('log operation is not supported');
  }
  if (outcome !== 'allowed' && outcome !== 'denied') {
    throw new TypeError('log outcome must be "allowed" or "denied"');
  }
  const canonicalIssuer = canonicalOAuthIssuer(issuer);
  const reasonField = readOwnDataProperty(context, 'reason');
  const reason = reasonField.found && reasonField.value !== undefined ? reasonField.value : undefined;
  if (reason !== undefined && typeof reason !== 'string') {
    throw new TypeError('log reason must be a string');
  }
  const reasonSuffix =
    reason !== undefined && OAUTH_LOG_SAFE_REASONS.has(reason) ? ` reason=${reason}` : '';
  return `oauth clientId=${clientId} issuer=${canonicalIssuer} operation=${operation} outcome=${outcome}${reasonSuffix}`;
}

// =====================================================================
// Gateway-owned credential vault and token store ports
// =====================================================================

/**
 * Gateway-owned credential vault. The host (which owns transport + OAuth
 * composition behind `McpReadClientGatewayPort`) persists client credentials
 * through this port, keyed by exact issuer. The Read application client
 * never receives this handle; raw client secrets are never logged and never
 * enter the shared authorization binding.
 */
export interface OAuthClientCredentialVaultPort {
  readonly saveClientCredentials: (
    issuer: string,
    credentials: OAuthStoredClientCredentials,
  ) => void | Promise<void>;
  readonly loadClientCredentials: (
    issuer: string,
  ) => OAuthStoredClientCredentials | undefined | Promise<OAuthStoredClientCredentials | undefined>;
  readonly deleteClientCredentials: (issuer: string) => void | Promise<void>;
}

/**
 * Gateway-owned OAuth token store, keyed by exact issuer. Refresh state
 * and access tokens live here so the application layer can never touch them;
 * the Read application client only sees `McpReadClientGatewayPort.callTool`.
 */
export interface OAuthClientTokenStorePort {
  readonly loadTokens: (
    issuer: string,
  ) => OAuthStoredTokens | undefined | Promise<OAuthStoredTokens | undefined>;
  readonly saveTokens: (issuer: string, tokens: OAuthStoredTokens) => void | Promise<void>;
  readonly deleteTokens: (issuer: string) => void | Promise<void>;
}