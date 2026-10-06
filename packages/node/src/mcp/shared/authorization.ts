/**
 * Generic MCP authorization bindings.
 *
 * `McpAuthorizationBinding` is the host-verified, token-free authorization
 * fact for every MCP `2026-07-28` request. Hosts authenticate and authorize a
 * request themselves, then map their trusted evidence to one of these
 * bindings; raw tokens, client secrets, API Key values and reversible
 * credential material never enter a binding.
 *
 * Discriminated union:
 * - `anonymous` — host-authorised public Resource Read only. `principalId` is
 *   fixed to `'public'`; it must never reach Plan, Approval, low-risk Write or
 *   commit APIs.
 * - `authenticated` — verified principal/client/credential binding plus
 *   resource audience and security epoch. Required for Plan, Approval,
 *   low-risk Write and commit.
 *
 * Host evidence mapping (verified stable identifiers only; never raw tokens):
 * - OAuth: verified `sub` -> principalId, OAuth `client_id` -> clientId,
 *   issuer-keyed credential binding id (RFC 9207 `iss` + DCR + key id) ->
 *   credentialBindingId.
 * - API Key: key owner/account -> principalId, key id -> clientId, host
 *   credential-store binding id -> credentialBindingId (the key value itself
 *   never enters).
 * - Service: service account identity -> principalId, service registration id
 *   -> clientId, service credential binding id -> credentialBindingId.
 * - stdio: configured local principal -> principalId, host configuration id ->
 *   clientId, local secret-store binding id -> credentialBindingId.
 *
 * Every constructor/validator snapshots and deep-freezes its input so
 * mutation-after-call cannot affect the produced binding. It rejects
 * accessors/Proxies, requires exact own enumerable data keys, rejects empty
 * ids and non-string audience/epoch, and refuses raw credential markers
 * (`containsRawSecretMarker`). The binding shape has no array fields; the
 * strict record validator therefore rejects arrays at the top level.
 *
 * `requireAuthenticatedWriteBinding` / `assertAuthenticatedBinding` narrow a
 * `McpAuthorizationBinding` to `McpAuthenticatedAuthorizationBinding` so the
 * anonymous branch cannot reach authenticated-only Plan/Write ports (verified
 * at compile time by `tests/mcp/mcp-2026-07-28-authorization-bindings.typecheck.ts`).
 */
import { types as nodeTypes } from 'node:util';

/** Anonymous public Resource Read binding fixed contract. */
export interface McpAnonymousAuthorizationBinding {
  readonly kind: 'anonymous';
  readonly principalId: 'public';
  readonly resourceAudience: string;
  readonly securityEpoch: string;
}

/** Authenticated binding fixed contract; required for Plan/Approval/Write/commit. */
export interface McpAuthenticatedAuthorizationBinding {
  readonly kind: 'authenticated';
  readonly principalId: string;
  readonly clientId: string;
  readonly credentialBindingId: string;
  readonly resourceAudience: string;
  readonly securityEpoch: string;
}

/** Generic host-verified MCP authorization binding (discriminated union). */
export type McpAuthorizationBinding =
  | McpAnonymousAuthorizationBinding
  | McpAuthenticatedAuthorizationBinding;

/** Credential families a trusted host may map into an authenticated binding. */
export type McpCredentialKind = 'oauth' | 'api-key' | 'service' | 'stdio';

/**
 * Verified OAuth evidence. The host has already validated the OAuth flow
 * (RFC 9207 `iss`, DCR, token exchange); only stable identifiers enter.
 */
export interface McpOAuthCredentialEvidence {
  readonly credentialKind: 'oauth';
  readonly principalId: string;
  readonly clientId: string;
  readonly credentialBindingId: string;
  readonly resourceAudience: string;
  readonly securityEpoch: string;
}

/** Verified API Key evidence (key value never enters). */
export type McpApiKeyCredentialEvidence = Omit<McpOAuthCredentialEvidence, 'credentialKind'> & {
  readonly credentialKind: 'api-key';
};

/** Verified Service credential evidence. */
export type McpServiceCredentialEvidence = Omit<McpOAuthCredentialEvidence, 'credentialKind'> & {
  readonly credentialKind: 'service';
};

/** Verified stdio host credential evidence (local secret-store binding id only). */
export type McpStdioCredentialEvidence = Omit<McpOAuthCredentialEvidence, 'credentialKind'> & {
  readonly credentialKind: 'stdio';
};

/** All verified host credential evidence kinds. */
export type McpHostCredentialEvidence =
  | McpOAuthCredentialEvidence
  | McpApiKeyCredentialEvidence
  | McpServiceCredentialEvidence
  | McpStdioCredentialEvidence;

/** Input for the anonymous public binding factory (audience + epoch only). */
export interface McpAnonymousBindingInput {
  readonly resourceAudience: string;
  readonly securityEpoch: string;
}

/** Typed failure codes for {@link McpAuthorizationBindingError}. */
export type McpAuthorizationBindingErrorCode =
  | 'invalid_binding'
  | 'missing_field'
  | 'unknown_field'
  | 'accessor_property'
  | 'invalid_kind'
  | 'invalid_principal'
  | 'empty_id'
  | 'non_string_text'
  | 'raw_secret_marker'
  | 'credential_kind_mismatch'
  | 'resource_audience_mismatch'
  | 'security_epoch_mismatch'
  | 'anonymous_write_forbidden';

/** Fail-closed validation error carrying a stable machine-readable code. */
export class McpAuthorizationBindingError extends TypeError {
  readonly code: McpAuthorizationBindingErrorCode;

  constructor(code: McpAuthorizationBindingErrorCode, message: string) {
    super(message);
    this.name = 'McpAuthorizationBindingError';
    this.code = code;
  }
}

const ANONYMOUS_BINDING_KEYS = Object.freeze([
  'kind',
  'principalId',
  'resourceAudience',
  'securityEpoch',
] as const);
const AUTHENTICATED_BINDING_KEYS = Object.freeze([
  'kind',
  'principalId',
  'clientId',
  'credentialBindingId',
  'resourceAudience',
  'securityEpoch',
] as const);
const ANONYMOUS_INPUT_KEYS = Object.freeze(['resourceAudience', 'securityEpoch'] as const);
const CREDENTIAL_EVIDENCE_KEYS = Object.freeze([
  'credentialKind',
  'principalId',
  'clientId',
  'credentialBindingId',
  'resourceAudience',
  'securityEpoch',
] as const);
const BINDING_KINDS = Object.freeze(['anonymous', 'authenticated'] as const);
const CREDENTIAL_KINDS = Object.freeze(['oauth', 'api-key', 'service', 'stdio'] as const);

/** Recognizable raw-credential value prefixes used by {@link containsRawSecretMarker}. */
export const RAW_SECRET_PREFIXES: readonly string[] = Object.freeze([
  'Bearer ',
  'Basic ',
  'sk-',
  'pk-live-',
  'pk-test-',
  'ghp_',
  'gho_',
  'glpat-',
  'xoxb-',
  'xoxp-',
  'AKIA',
  'ya29.',
  'eyJ',
] as const);

/** Own-key names treated as raw-credential carriers by {@link containsRawSecretMarker}. */
export const RAW_SECRET_KEY_NAMES: readonly string[] = Object.freeze([
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'secret',
  'clientSecret',
  'client_secret',
  'apiKey',
  'api_key',
  'apikey',
  'password',
  'authorization',
  'Authorization',
  'rawToken',
  'raw_token',
] as const);

type PlainRecord = Readonly<Record<string, unknown>>;

function assertPlainRecord(value: unknown, label: string): PlainRecord {
  if (
    typeof value !== 'object'
    || value === null
    || nodeTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    throw new McpAuthorizationBindingError(
      'invalid_binding',
      `${label} must be a plain object; non-objects, arrays and Proxies are rejected.`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new McpAuthorizationBindingError(
      'invalid_binding',
      `${label} must use a plain object prototype.`,
    );
  }
  return value as PlainRecord;
}

function assertExactKeys(record: PlainRecord, expected: readonly string[], label: string): void {
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !expected.includes(key)) {
      throw new McpAuthorizationBindingError(
        'unknown_field',
        `${label} contains an unknown field: ${String(key)}`,
      );
    }
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new McpAuthorizationBindingError('missing_field', `${label} is missing required field: ${key}`);
    }
  }
}

function ownDataValue(record: PlainRecord, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) {
    throw new McpAuthorizationBindingError('missing_field', `${label} is missing required field: ${key}`);
  }
  if (!('value' in descriptor)) {
    throw new McpAuthorizationBindingError(
      'accessor_property',
      `${label}.${key} must be an own data property; accessors are rejected.`,
    );
  }
  if (descriptor.enumerable !== true) {
    throw new McpAuthorizationBindingError(
      'invalid_binding',
      `${label}.${key} must be an enumerable own data property.`,
    );
  }
  return descriptor.value;
}

function readKind(record: PlainRecord, key: string, allowed: readonly string[], label: string): string {
  const value = ownDataValue(record, key, label);
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new McpAuthorizationBindingError(
      'invalid_kind',
      `${label}.${key} must be one of: ${allowed.join(', ')}.`,
    );
  }
  return value;
}

function readText(record: PlainRecord, key: string, label: string): string {
  const value = ownDataValue(record, key, label);
  if (typeof value !== 'string') {
    throw new McpAuthorizationBindingError('non_string_text', `${label}.${key} must be a string.`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new McpAuthorizationBindingError('empty_id', `${label}.${key} must not be empty.`);
  }
  if (containsRawSecretMarker(value)) {
    throw new McpAuthorizationBindingError(
      'raw_secret_marker',
      `${label}.${key} must not contain raw credential material.`,
    );
  }
  return value;
}

function buildAnonymousBinding(
  resourceAudience: string,
  securityEpoch: string,
): McpAnonymousAuthorizationBinding {
  return Object.freeze({
    kind: 'anonymous',
    principalId: 'public',
    resourceAudience,
    securityEpoch,
  });
}

function buildAuthenticatedBinding(
  principalId: string,
  clientId: string,
  credentialBindingId: string,
  resourceAudience: string,
  securityEpoch: string,
): McpAuthenticatedAuthorizationBinding {
  return Object.freeze({
    kind: 'authenticated',
    principalId,
    clientId,
    credentialBindingId,
    resourceAudience,
    securityEpoch,
  });
}

/**
 * Strict snapshot/freeze validator: returns a deep, frozen binding from a
 * plain object literal and rejects proxies, accessors, missing/extra fields,
 * empty ids, non-string audience/epoch, cross-kind confusion and raw secret
 * markers. The returned binding is a fresh copy, so mutating the input after
 * the call cannot affect it.
 */
export function snapshotMcpAuthorizationBinding(value: unknown): McpAuthorizationBinding {
  const record = assertPlainRecord(value, 'MCP authorization binding');
  const kind = readKind(record, 'kind', BINDING_KINDS, 'MCP authorization binding');
  if (kind === 'anonymous') {
    assertExactKeys(record, ANONYMOUS_BINDING_KEYS, 'MCP anonymous authorization binding');
    const principalId = readText(record, 'principalId', 'MCP anonymous authorization binding');
    if (principalId !== 'public') {
      throw new McpAuthorizationBindingError(
        'invalid_principal',
        'MCP anonymous authorization binding principalId must be "public".',
      );
    }
    const resourceAudience = readText(record, 'resourceAudience', 'MCP anonymous authorization binding');
    const securityEpoch = readText(record, 'securityEpoch', 'MCP anonymous authorization binding');
    return buildAnonymousBinding(resourceAudience, securityEpoch);
  }
  assertExactKeys(record, AUTHENTICATED_BINDING_KEYS, 'MCP authenticated authorization binding');
  const principalId = readText(record, 'principalId', 'MCP authenticated authorization binding');
  const clientId = readText(record, 'clientId', 'MCP authenticated authorization binding');
  const credentialBindingId = readText(
    record,
    'credentialBindingId',
    'MCP authenticated authorization binding',
  );
  const resourceAudience = readText(record, 'resourceAudience', 'MCP authenticated authorization binding');
  const securityEpoch = readText(record, 'securityEpoch', 'MCP authenticated authorization binding');
  return buildAuthenticatedBinding(
    principalId,
    clientId,
    credentialBindingId,
    resourceAudience,
    securityEpoch,
  );
}

/**
 * Host factory for the anonymous branch. Use only when the host has explicitly
 * authorised a public Resource Read; Plan/Approval/low-risk Write/commit must
 * use authenticated bindings instead.
 */
export function createAnonymousPublicBinding(input: McpAnonymousBindingInput): McpAnonymousAuthorizationBinding {
  const record = assertPlainRecord(input, 'anonymous public binding input');
  assertExactKeys(record, ANONYMOUS_INPUT_KEYS, 'anonymous public binding input');
  const resourceAudience = readText(record, 'resourceAudience', 'anonymous public binding input');
  const securityEpoch = readText(record, 'securityEpoch', 'anonymous public binding input');
  return buildAnonymousBinding(resourceAudience, securityEpoch);
}

function snapshotAuthenticatedEvidence(
  evidence: unknown,
  expectedKind: McpCredentialKind,
): McpAuthenticatedAuthorizationBinding {
  const record = assertPlainRecord(evidence, 'MCP credential evidence');
  assertExactKeys(record, CREDENTIAL_EVIDENCE_KEYS, 'MCP credential evidence');
  const kind = readKind(record, 'credentialKind', CREDENTIAL_KINDS, 'MCP credential evidence');
  if (kind !== expectedKind) {
    throw new McpAuthorizationBindingError(
      'credential_kind_mismatch',
      `Expected ${expectedKind} credential evidence but received ${kind}.`,
    );
  }
  const principalId = readText(record, 'principalId', 'MCP credential evidence');
  const clientId = readText(record, 'clientId', 'MCP credential evidence');
  const credentialBindingId = readText(record, 'credentialBindingId', 'MCP credential evidence');
  const resourceAudience = readText(record, 'resourceAudience', 'MCP credential evidence');
  const securityEpoch = readText(record, 'securityEpoch', 'MCP credential evidence');
  return buildAuthenticatedBinding(
    principalId,
    clientId,
    credentialBindingId,
    resourceAudience,
    securityEpoch,
  );
}

/** Map verified OAuth evidence (subject, client, issuer-keyed binding) to an authenticated binding. */
export function mapOAuthEvidenceToAuthenticatedBinding(
  evidence: McpOAuthCredentialEvidence,
): McpAuthenticatedAuthorizationBinding {
  return snapshotAuthenticatedEvidence(evidence, 'oauth');
}

/** Map verified API Key evidence (owner, key id, store binding) to an authenticated binding. */
export function mapApiKeyEvidenceToAuthenticatedBinding(
  evidence: McpApiKeyCredentialEvidence,
): McpAuthenticatedAuthorizationBinding {
  return snapshotAuthenticatedEvidence(evidence, 'api-key');
}

/** Map verified Service evidence to an authenticated binding. */
export function mapServiceEvidenceToAuthenticatedBinding(
  evidence: McpServiceCredentialEvidence,
): McpAuthenticatedAuthorizationBinding {
  return snapshotAuthenticatedEvidence(evidence, 'service');
}

/** Map verified stdio host evidence to an authenticated binding. */
export function mapStdioEvidenceToAuthenticatedBinding(
  evidence: McpStdioCredentialEvidence,
): McpAuthenticatedAuthorizationBinding {
  return snapshotAuthenticatedEvidence(evidence, 'stdio');
}

/**
 * Generic dispatcher: reads the verified `credentialKind` (after proxy/plain
 * validation, so no trap runs) and delegates to the matching mapper.
 */
export function createAuthenticatedBinding(
  evidence: McpHostCredentialEvidence,
): McpAuthenticatedAuthorizationBinding {
  const kind = readEvidenceKind(evidence);
  switch (kind) {
    case 'oauth':
      return mapOAuthEvidenceToAuthenticatedBinding(evidence as McpOAuthCredentialEvidence);
    case 'api-key':
      return mapApiKeyEvidenceToAuthenticatedBinding(evidence as McpApiKeyCredentialEvidence);
    case 'service':
      return mapServiceEvidenceToAuthenticatedBinding(evidence as McpServiceCredentialEvidence);
    case 'stdio':
      return mapStdioEvidenceToAuthenticatedBinding(evidence as McpStdioCredentialEvidence);
  }
}

function readEvidenceKind(evidence: unknown): McpCredentialKind {
  const record = assertPlainRecord(evidence, 'MCP credential evidence');
  assertExactKeys(record, CREDENTIAL_EVIDENCE_KEYS, 'MCP credential evidence');
  const kind = readKind(record, 'credentialKind', CREDENTIAL_KINDS, 'MCP credential evidence');
  return kind as McpCredentialKind;
}

/** Non-throwing predicate for the whole binding union. */
export function isMcpAuthorizationBinding(value: unknown): value is McpAuthorizationBinding {
  try {
    snapshotMcpAuthorizationBinding(value);
    return true;
  } catch {
    return false;
  }
}

/** Non-throwing predicate for the anonymous branch. */
export function isMcpAnonymousAuthorizationBinding(
  value: unknown,
): value is McpAnonymousAuthorizationBinding {
  return isMcpAuthorizationBinding(value) && value.kind === 'anonymous';
}

/** Non-throwing predicate for the authenticated branch. */
export function isMcpAuthenticatedAuthorizationBinding(
  value: unknown,
): value is McpAuthenticatedAuthorizationBinding {
  return isMcpAuthorizationBinding(value) && value.kind === 'authenticated';
}

/**
 * Authenticated-only helper: narrows a union binding to the authenticated
 * branch and rejects the anonymous branch, so anonymous bindings cannot pass
 * through compile-time type-checking into Plan/Write APIs.
 */
export function assertAuthenticatedBinding(
  binding: McpAuthorizationBinding,
): asserts binding is McpAuthenticatedAuthorizationBinding {
  if (binding.kind !== 'authenticated') {
    throw new McpAuthorizationBindingError(
      'anonymous_write_forbidden',
      'Anonymous MCP bindings cannot be used for authenticated Plan/Write APIs.',
    );
  }
}

/** Authenticated-only helper that returns the narrowed authenticated binding. */
export function requireAuthenticatedWriteBinding(
  binding: McpAuthorizationBinding,
): McpAuthenticatedAuthorizationBinding {
  assertAuthenticatedBinding(binding);
  return binding;
}

/** Strict equality check of the binding's resource audience. */
export function bindingMatchesResourceAudience(
  binding: McpAuthorizationBinding,
  resourceAudience: string,
): boolean {
  return binding.resourceAudience === resourceAudience;
}

/** Strict equality check of the binding's security epoch. */
export function bindingMatchesSecurityEpoch(
  binding: McpAuthorizationBinding,
  securityEpoch: string,
): boolean {
  return binding.securityEpoch === securityEpoch;
}

/** Rejects the binding when its resource audience differs from the expected one. */
export function assertBindingMatchesResourceAudience(
  binding: McpAuthorizationBinding,
  resourceAudience: string,
): void {
  if (!bindingMatchesResourceAudience(binding, resourceAudience)) {
    throw new McpAuthorizationBindingError(
      'resource_audience_mismatch',
      `MCP authorization binding audience "${binding.resourceAudience}" does not match expected audience "${resourceAudience}".`,
    );
  }
}

/** Rejects the binding when its security epoch differs from the expected one. */
export function assertBindingMatchesSecurityEpoch(
  binding: McpAuthorizationBinding,
  securityEpoch: string,
): void {
  if (!bindingMatchesSecurityEpoch(binding, securityEpoch)) {
    throw new McpAuthorizationBindingError(
      'security_epoch_mismatch',
      `MCP authorization binding security epoch "${binding.securityEpoch}" does not match expected epoch "${securityEpoch}".`,
    );
  }
}

/**
 * Heuristic scanner for recognizable raw credential material (tokens, client
 * secrets, API Key values). Used by the strict validators as a defense-in-depth
 * marker check; hosts may also call it on evidence before mapping. Cycle-safe
 * and proxy-safe: Proxies are treated as clean (never trap), and no accessor is
 * ever invoked.
 */
export function containsRawSecretMarker(value: unknown): boolean {
  return containsRawSecretMarkerInternal(value, new WeakSet<object>());
}

function containsRawSecretMarkerInternal(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value === 'string') {
    return RAW_SECRET_PREFIXES.some((prefix) => value.startsWith(prefix));
  }
  if (typeof value !== 'object' || value === null || nodeTypes.isProxy(value)) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key !== 'string' || !RAW_SECRET_KEY_NAMES.includes(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor !== undefined
        && 'value' in descriptor
        && descriptor.value !== ''
        && descriptor.value !== null
        && descriptor.value !== undefined
      ) {
        return true;
      }
    }
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor !== undefined
        && 'value' in descriptor
        && containsRawSecretMarkerInternal(descriptor.value, seen)
      ) {
        return true;
      }
    }
    return false;
  } finally {
    seen.delete(value);
  }
}